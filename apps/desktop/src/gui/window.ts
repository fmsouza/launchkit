import {
  IpcMethodSchemas,
  type ServerTransport,
  createIpcServer,
} from "@spectrum/ipc"
import { detectPlatform } from "@spectrum/platform"
import type { GuiContext } from "../composition"
import { createIpcHandlers } from "./ipc/handlers"
import type { WindowBounds } from "./window-bounds"
import { type WindowBoundsIO, createWindowBoundsIO } from "./window-bounds-io"

// Linux must use CEF (GTK/WebKit can't handle Electrobun's webview layering); native elsewhere.
const RENDERER: "cef" | "native" =
  detectPlatform() === "linux" ? "cef" : "native"

/**
 * Window focus seam. A `let focused` flag, flipped by the Electrobun BrowserWindow `focus`/`blur`
 * events (bound in `realOpenWindowDeps.createWindow`), read synchronously by composition through
 * `isWindowFocused`. The notification service uses it to suppress native notifications while the
 * window is focused (the in-app toast covers that case).
 *
 * Default `true` (assume focused at launch). The native window emits `focus` on activation and
 * `blur` when it loses key status, so the flag tracks the real OS focus state once the window opens.
 */
let focused = true

/** Synchronous read of the current window focus flag (see {@link focused}). */
export const isWindowFocused = (): boolean => focused

/** Internal: bind the Electrobun focus/blur events of a constructed BrowserWindow to the flag. */
const bindFocusEvents = (window: {
  on(name: string, handler: (event: unknown) => void): void
}): void => {
  window.on("focus", () => {
    focused = true
  })
  window.on("blur", () => {
    focused = false
  })
}

/** Internal: forward Electrobun resize/move events to the debounced bounds sink. */
const bindBoundsEvents = (
  window: {
    on(name: string, handler: (event: unknown) => void): void
    getFrame(): WindowBounds
  },
  onBoundsChange: (bounds: WindowBounds) => void,
): void => {
  window.on("resize", () => onBoundsChange(window.getFrame()))
  window.on("move", () => onBoundsChange(window.getFrame()))
}

/** The subset of BrowserWindow options this shell sets (security.md webview hardening). */
export interface WindowOptions {
  readonly url: string
  readonly title: string
  /** Resolve the initial frame from persisted (sanity-checked) bounds, or the default. */
  readonly loadInitialFrame: () => Promise<WindowBounds>
  /** Record a new window geometry on resize/move (debounced + persisted downstream). */
  readonly onBoundsChange: (bounds: WindowBounds) => void
  /**
   * Called once the native webview exists, handed a fn that reloads the SPA. The bun
   * side uses this to recover from a dead WKWebView content process (Electrobun 1.18.1
   * emits no termination event), since `loadURL` respawns the content process.
   */
  readonly onWebviewReady?: (reload: () => void) => void
}

/**
 * True for a genuinely external (web) navigation target we want to hand to the
 * OS browser. Deliberately strict: ONLY `http(s)://`. This excludes the app's
 * own `views://` origin (the SPA's startup/internal navigations, which must
 * stay in-window) and any non-string/garbage detail (a non-string here once
 * crashed the bun worker via `Utils.openExternal(undefined)` →
 * `toCString(undefined)`). Custom schemes (mailto:, slack://) are NOT opened on
 * this native path — they remain supported on the explicit React click → IPC
 * `openExternalUrl` path, which validates and forwards them.
 */
const isExternalWebUrl = (url: unknown): url is string =>
  typeof url === "string" &&
  (url.startsWith("https://") || url.startsWith("http://"))

/**
 * Native navigation allow/deny rules that lock this window's webview to the
 * app's OWN `views://main/*` origin. Electrobun 1.18.1 evaluates these in native
 * code synchronously (no callback into the bun process), so this is a real
 * origin lock, not a best-effort observation.
 *
 * Grammar (Electrobun 1.18.1): a `^`-prefixed pattern DENIES; an un-prefixed
 * pattern ALLOWS; `*` is the only wildcard (glob), matching is case-insensitive
 * over the whole URL, and the LAST matching rule wins. Critically, a URL that
 * matches NO rule defaults to ALLOW — so a lock must deny everything first, then
 * re-allow only the trusted origin. Hence `^*` (block all) followed by
 * `views://main/*` (re-allow only the SPA's own origin). Every other target
 * (`http(s)://…`, `file://…`, other `views://` hosts) matches only `^*` and is
 * refused natively. Order is load-bearing; keep the deny rule first.
 */
export const ORIGIN_LOCK_RULES: readonly string[] = ["^*", "views://main/*"]

/**
 * Apply the native {@link ORIGIN_LOCK_RULES} to the window's webview so it can
 * ONLY ever load `views://main/*` — any other navigation is refused by
 * Electrobun's native code. Pure over the injected window so it is testable
 * without a real BrowserView; the real `createWindow` wires it with the live
 * `BrowserView`. `setNavigationRules` takes a mutable `string[]`, so the frozen
 * policy constant is spread into a fresh array.
 */
export const bindNavigationLock = (
  win: {
    readonly webview: { setNavigationRules(rules: string[]): void }
  },
  rules: readonly string[] = ORIGIN_LOCK_RULES,
): void => {
  win.webview.setNavigationRules([...rules])
}

/**
 * Subscribe to the window's webview `will-navigate` event and open genuinely
 * external (`http(s)`) navigation targets in the OS browser via `openExternal`.
 * Pure over the injected window + opener; the real `createWindow` wires it with
 * the live `BrowserView` + `Utils.openExternal`.
 *
 * `window.webview` is the Electrobun `BrowserView`. Its `on("will-navigate")`
 * delivers an `ElectrobunEvent` whose URL is at `event.data.detail` (see
 * `electrobun/dist/api/bun/events/webviewEvents.ts` — `willNavigate` builds the
 * event from `{ detail }`). We open that url externally as a best-effort
 * convenience, but ONLY when it is an external web URL: CEF on Linux fires
 * `will-navigate` for the SPA's own `views://` startup load, which must NOT be
 * routed to the browser (and reading the wrong field / an undefined url
 * previously crashed the process — see {@link isExternalWebUrl}).
 *
 * The origin lock IS now set natively: `bindNavigationLock` calls
 * `BrowserView.setNavigationRules(...)` (see {@link ORIGIN_LOCK_RULES}) so
 * non-`views://main` navigation is refused in native code before this handler
 * ever runs. `will-navigate` itself remains purely observational in Electrobun
 * 1.18.1 — a plain event subscription whose handler return value is discarded
 * (see `electrobun/dist/api/bun/core/BrowserView.ts` `on(...)`), so it still
 * cannot itself cancel a load — but for a denied external navigation, native
 * has already cancelled it by the time this handler fires, so opening it here
 * is a clean redirect to the OS browser rather than a race with an in-window
 * load. The primary external-link guarantee remains the React click path
 * (`MessageBubble` calls `e.preventDefault()` then routes to the
 * `openExternalUrl` IPC); this handler only catches the non-click paths React
 * can't see.
 */
export const bindExternalNavigation = (
  win: {
    readonly webview: {
      on(
        name: "will-navigate",
        handler: (event: {
          readonly data?: { readonly detail?: unknown }
        }) => void,
      ): void
    }
  },
  openExternal: (url: string) => boolean,
): void => {
  win.webview.on("will-navigate", (event) => {
    const url = event.data?.detail
    if (isExternalWebUrl(url)) openExternal(url)
  })
}

/**
 * Hand the caller a fn that reloads the SPA by re-navigating the webview to its
 * own `views://` entry. Pure over the injected window so it is testable without a
 * real BrowserView. The real `createWindow` wires it with the live webview; the
 * reload respawns a terminated WKWebView content process (the blank-after-sleep fix).
 */
export const bindWebviewReload = (
  win: { readonly webview: { loadURL(url: string): void } },
  viewUrl: string,
  onReady: (reload: () => void) => void,
): void => {
  onReady(() => win.webview.loadURL(viewUrl))
}

/**
 * The Electrobun seam, injected so the logic is testable without a real window. `createWindow`
 * opens the BrowserWindow; `makeTransport` builds a `ServerTransport` over the Electrobun message
 * bus for that window; `wireServer` registers the validated IPC handlers on it. (The canonical
 * run-event stream runs over a separate loopback WebSocket — see runner-socket.ts — not this
 * Electrobun seam.)
 */
export interface OpenWindowDeps {
  readonly createWindow: (opts: WindowOptions) => unknown
  readonly makeTransport: (window: unknown) => ServerTransport
  readonly wireServer: (transport: ServerTransport, ctx: GuiContext) => void
  /** Build the bounds restore/persist seam from the live context (config + logger). */
  readonly createBoundsIO: (ctx: GuiContext) => WindowBoundsIO
  readonly viewUrl: string
}

/** Default `wireServer`: bind the contract handlers to the transport (validated both directions). */
const defaultWireServer = (
  transport: ServerTransport,
  ctx: GuiContext,
): void => {
  createIpcServer(createIpcHandlers(ctx), transport)
}

/**
 * Open the GUI window and wire the typed IPC server to it. Thin by design: all decision logic lives
 * in `createIpcHandlers` (tested in desktop-shell-02); this only assembles Electrobun pieces, so it
 * is smoke-tested. SECURITY: the window loads the local built `views/main` only (the strict CSP in
 * `index.html` blocks remote scripts/eval), so the webview gets no direct fs/network/secret access,
 * only the validated IPC. The native origin lock (`bindNavigationLock`) now prevents any
 * non-`views://main` navigation in native code; `bindExternalNavigation` opens the (now-cancelled)
 * external target in the OS browser as a convenience (see its doc comment).
 */
export const openWindow = (
  ctx: GuiContext,
  deps: OpenWindowDeps = realOpenWindowDeps,
): void => {
  const io = deps.createBoundsIO(ctx)
  const window = deps.createWindow({
    url: deps.viewUrl,
    title: "Spectrum",
    loadInitialFrame: io.loadInitialFrame,
    onBoundsChange: io.onBoundsChange,
    onWebviewReady: (reload) => ctx.rendererWatchdog.bindReload(reload),
  })
  const transport = deps.makeTransport(window)
  deps.wireServer(transport, ctx)
}

/** The inbound IPC handler the webview's RPC requests are dispatched to (bound by `wireServer`). */
type ServerHandler = (method: string, payload: unknown) => Promise<unknown>

/**
 * What `createWindow` hands to `makeTransport`: the late-binding hook for the IPC server handler.
 * The Electrobun RPC request handlers are fixed at `BrowserWindow` construction, but the project's
 * `ServerTransport.onRequest(handler)` is called afterwards (in `wireServer`) — so the RPC handlers
 * delegate to this mutable slot, which `makeTransport` fills. The webview only issues requests once
 * its view has loaded, by which point the handler is bound.
 */
interface WindowBundle {
  readonly bindHandler: (handler: ServerHandler) => void
}

/**
 * Production Electrobun wiring. The bun-side RPC exposes one request handler per IPC method name
 * (from `IpcMethodSchemas`); each delegates to the bound `ServerTransport` handler, which
 * `createIpcServer` validates both directions. The webview side (`views/main/ipc-client.ts`)
 * mirrors this with `Electroview.defineRPC`. SECURITY: the window only ever loads `views://main/*`
 * (the strict CSP in `index.html` blocks remote scripts/eval), so the webview gets no direct
 * fs/network/secret access, only validated IPC — and the native origin lock (`bindNavigationLock`)
 * now prevents any non-`views://main` navigation in the webview itself. `bindExternalNavigation`
 * opens the (now-cancelled) external target in the OS browser as a convenience (see its doc
 * comment).
 */
export const realOpenWindowDeps: OpenWindowDeps = {
  createWindow: (opts) => {
    let handler: ServerHandler | null = null

    // One delegating request handler per IPC method; routes to the bound server handler.
    const requests: Record<string, (payload: unknown) => Promise<unknown>> =
      Object.fromEntries(
        Object.keys(IpcMethodSchemas).map((method) => [
          method,
          (payload: unknown): Promise<unknown> =>
            handler === null
              ? Promise.reject(new Error("ipc server not ready"))
              : handler(method, payload),
        ]),
      )

    // Load Electrobun lazily — and only in the built binary. A top-level import would pull its
    // native FFI module into `bun test`; the tested paths use injected fake deps and never reach
    // here. The webview only issues requests after its view loads, by which point `bindHandler`
    // has run, so deferring window creation past this dynamic import is safe.
    void import("electrobun/bun").then(
      async ({ BrowserWindow, defineElectrobunRPC, Utils }) => {
        // Electrobun carries only the IPC requests now. The canonical run-event stream runs over a
        // dedicated loopback WebSocket (see runner-socket.ts), so there is no `messages` channel or
        // outbound bind here anymore.
        const rpc = defineElectrobunRPC("bun", {
          maxRequestTime: 5000,
          handlers: { requests: {}, messages: {} },
          extraRequestHandlers: requests,
        })
        // Restore the last-known geometry (sanity-checked upstream); falls back to
        // the default frame on first run or when persisted bounds fail the guard.
        const frame = await opts.loadInitialFrame()
        const win = new BrowserWindow({
          title: opts.title,
          url: opts.url,
          frame,
          renderer: RENDERER,
          rpc,
        })
        // SECURITY: lock the webview to the app's own views://main origin so
        // Electrobun natively REFUSES any other navigation (see ORIGIN_LOCK_RULES).
        // Applied first so the lock is in place before any post-load navigation;
        // the initial views://main/index.html load matches the allow rule.
        bindNavigationLock(win)
        // Track OS focus so background runs (window unfocused) fire a native notification.
        bindFocusEvents(win)
        // Persist size/position as the user resizes/moves the window.
        bindBoundsEvents(win, opts.onBoundsChange)
        // Open EXTERNAL http(s) in-webview navigation (right-click "Open Link",
        // dragged URL, programmatic location.href) in the OS browser via
        // Utils.openExternal. bindExternalNavigation filters to external web URLs
        // only, so the SPA's own views:// startup load stays in-window (CEF on
        // Linux fires will-navigate for it). NOTE: the native origin lock (above)
        // now prevents the in-window load of a denied external target — this
        // handler just opens that refused target in the OS browser as a
        // convenience. The primary external-link path is MessageBubble's
        // preventDefault + openExternalUrl IPC; this only catches the paths React
        // can't see. `Utils` is already in scope from the outer import, so no
        // second dynamic import is needed.
        bindExternalNavigation(win, (url) => Utils.openExternal(url))
        // Hand the bun-side renderer watchdog a reload fn so it can respawn a dead
        // WKWebView content process (Electrobun emits no termination event).
        bindWebviewReload(win, opts.url, (reload) =>
          opts.onWebviewReady?.(reload),
        )
      },
    )

    const bundle: WindowBundle = {
      bindHandler: (h) => {
        handler = h
      },
    }
    return bundle
  },
  makeTransport: (window) => ({
    onRequest: (h) => {
      ;(window as WindowBundle).bindHandler(h)
    },
  }),
  wireServer: defaultWireServer,
  createBoundsIO: (ctx) =>
    createWindowBoundsIO({ config: ctx.config, log: ctx.log }),
  viewUrl: "views://main/index.html",
}

import { type ServerTransport, createIpcServer } from "@launchkit/ipc"
import type { AppContext } from "../composition"
import { createIpcHandlers } from "./ipc/handlers"

/** The subset of BrowserWindow options this shell sets (security.md webview hardening). */
export interface WindowOptions {
  readonly url: string
  readonly title: string
  /** Lock navigation to the app origin; external links open in the system browser, not the webview. */
  readonly lockNavigationToOrigin: boolean
}

/**
 * The Electrobun seam, injected so the logic is testable without a real window. `createWindow`
 * opens the BrowserWindow; `makeTransport` builds a `ServerTransport` over the Electrobun message
 * bus for that window; `wireServer` registers the validated IPC handlers on it.
 */
export interface OpenWindowDeps {
  readonly createWindow: (opts: WindowOptions) => unknown
  readonly makeTransport: (window: unknown) => ServerTransport
  readonly wireServer: (transport: ServerTransport, ctx: AppContext) => void
  readonly viewUrl: string
}

/** Default `wireServer`: bind the contract handlers to the transport (validated both directions). */
const defaultWireServer = (
  transport: ServerTransport,
  ctx: AppContext,
): void => {
  createIpcServer(createIpcHandlers(ctx), transport)
}

/**
 * Open the GUI window and wire the typed IPC server to it. Thin by design: all decision logic lives
 * in `createIpcHandlers` (tested in desktop-shell-02); this only assembles Electrobun pieces, so it
 * is smoke-tested. SECURITY: the window loads the local built `views/main` only and locks navigation
 * to the app origin — the webview gets no direct fs/network/secret access, only the validated IPC.
 */
export const openWindow = (
  ctx: AppContext,
  deps: OpenWindowDeps = realOpenWindowDeps,
): void => {
  const window = deps.createWindow({
    url: deps.viewUrl,
    title: "LaunchKit",
    lockNavigationToOrigin: true,
  })
  const transport = deps.makeTransport(window)
  deps.wireServer(transport, ctx)
}

/**
 * Production Electrobun wiring. CONFIRM the exact `BrowserWindow` constructor + message-bus API
 * against the installed Electrobun version (context7 / Electrobun docs) and adapt ONLY this block.
 * The view url points at the built `views/main` entry declared in `electrobun.config.ts`.
 */
export const realOpenWindowDeps: OpenWindowDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electrobun types confirmed at impl time
  createWindow: (_opts) => {
    // Example shape — adapt to the installed Electrobun API:
    //   import { BrowserWindow } from "electrobun/bun"
    //   return new BrowserWindow({ title: opts.title, url: opts.url, /* CSP/navigation lock */ })
    throw new Error(
      "openWindow: wire the real Electrobun BrowserWindow here (see ELECTROBUN NOTE)",
    )
  },
  makeTransport: (_window) => {
    // Build a ServerTransport over the window's Electrobun RPC/message bus:
    //   return { onRequest: (handler) => window.webview.on("ipc", (method, payload) => handler(method, payload)) }
    throw new Error(
      "openWindow: wire the real Electrobun transport here (see ELECTROBUN NOTE)",
    )
  },
  wireServer: defaultWireServer,
  viewUrl: "views://main/index.html",
}

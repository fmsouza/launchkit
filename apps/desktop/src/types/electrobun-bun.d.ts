/**
 * Local type surface for the Electrobun **bun-side** API (`electrobun/bun`) we consume.
 *
 * WHY THIS EXISTS: Electrobun (v1.18.x) publishes its API as raw `.ts` source via its package
 * `exports` (e.g. `"electrobun/bun" → dist/api/bun/index.ts`), not pre-built `.d.ts`. That source
 * does not compile under this repo's strict settings (`exactOptionalPropertyTypes`,
 * `noImplicitReturns`, no implicit `any`, missing `@types/three`), and `skipLibCheck` only skips
 * `.d.ts` files — so importing it directly drags Electrobun's internals into our typecheck and fails
 * the gate. This file is mapped onto `"electrobun/bun"` via the desktop `tsconfig.json` `paths`
 * (TYPE RESOLUTION ONLY) — Bun's runtime and the Electrobun bundler resolve the real module.
 *
 * It models ONLY the subset used by `gui/window.ts` and `gui/tray.ts`. Extend it (against
 * `node_modules/electrobun/dist/api/bun/**`) if we start using more of the API.
 */

/** Window frame geometry (all fields required when `frame` is supplied). */
export interface WindowFrame {
  width: number
  height: number
  x: number
  y: number
}

/** Subset of `WindowOptionsType` used here. `rpc` accepts a `defineElectrobunRPC` result. */
export interface WindowOptions {
  title?: string
  url?: string | null
  frame?: WindowFrame
  rpc?: unknown
  renderer?: "native" | "cef"
}

/**
 * Subset of the BrowserView navigation API we consume (will-navigate, loadURL,
 * setNavigationRules). The `will-navigate` handler receives an `ElectrobunEvent`
 * whose navigation URL is at `event.data.detail` (mirrors
 * `electrobun/dist/api/bun/events/webviewEvents.ts` `willNavigate`, which builds
 * the event from `{ detail: <url> }`).
 */
export interface BrowserViewNavEvents {
  on(
    name: "will-navigate",
    handler: (event: { readonly data: { readonly detail: string } }) => void,
  ): void
  /** Reload the webview by navigating to a new URL (e.g. to respawn a dead content process). */
  loadURL(url: string): void
  /**
   * Set the native navigation allow/deny rules (see `electrobun/dist/api/bun/core/BrowserView.ts`
   * `setNavigationRules`). Mirrors the real `BrowserView`/webview-tag API,
   * which takes a mutable `string[]`.
   */
  setNavigationRules(rules: string[]): void
}

export class BrowserWindow {
  constructor(options?: WindowOptions)
  /** Subscribe to a window event (e.g. `"focus"`, `"blur"`, `"resize"`, `"move"`). */
  on(name: string, handler: (event: unknown) => void): void
  /** Read the window's current geometry synchronously. */
  getFrame(): WindowFrame
  /** The window's webview; subscribe to navigation events via `.on("will-navigate", ...)`. */
  readonly webview: BrowserViewNavEvents
}

/** Subset of the `defineElectrobunRPC` config (bun side). */
export interface ElectrobunRpcConfig {
  maxRequestTime?: number
  handlers: {
    requests?: Record<string, (payload: unknown) => unknown>
    messages?: Record<string, (payload: unknown) => unknown>
  }
  /** Untyped escape hatch for dynamically-built request handlers (one per IPC method). */
  extraRequestHandlers?: Record<string, (payload: unknown) => unknown>
}

/** Create the bun-side RPC object passed to `BrowserWindow({ rpc })`. */
export function defineElectrobunRPC(
  side: "bun" | "webview",
  config: ElectrobunRpcConfig,
): unknown

/** Native tray menu item descriptor. */
export type MenuItemConfig =
  | { type: "divider" | "separator" }
  | {
      type: "normal"
      label: string
      tooltip?: string
      action?: string
      submenu?: MenuItemConfig[]
      enabled?: boolean
      checked?: boolean
      hidden?: boolean
    }

/** A native application/context-menu item (role-based items map to NSResponder selectors). */
export type ApplicationMenuItemConfig =
  | { type: "divider" | "separator" }
  | {
      type?: "normal"
      label?: string
      role?: string
      action?: string
      tooltip?: string
      accelerator?: string
      enabled?: boolean
      checked?: boolean
      hidden?: boolean
      submenu?: ApplicationMenuItemConfig[]
    }

/** The bun-side application-menu namespace we consume. */
export const ApplicationMenu: {
  setApplicationMenu(menu: ApplicationMenuItemConfig[]): void
}

export interface TrayOptions {
  title?: string
  image?: string
  template?: boolean
  width?: number
  height?: number
}

export class Tray {
  constructor(options?: TrayOptions)
  setMenu(menu: MenuItemConfig[]): void
  on(name: "tray-clicked", handler: (event: unknown) => void): void
  remove(): void
}

/** Options for the native open dialog. `exactOptionalPropertyTypes`-safe (no `| undefined`). */
export interface OpenFileDialogOptions {
  canChooseDirectory?: boolean
  canChooseFiles?: boolean
  allowsMultipleSelection?: boolean
  startingFolder?: string
}

/** Native desktop notification options (`exactOptionalPropertyTypes`-safe). */
export interface NotificationOptions {
  /** The title of the notification (required). */
  title: string
  /** The main body text. */
  body?: string
  /** A subtitle (macOS shows this between title and body). */
  subtitle?: string
  /** If true, the notification plays no sound. */
  silent?: boolean
}

/** Subset of the Electrobun bun-side `Utils` namespace we consume. */
export const Utils: {
  /** Native open panel; resolves the selected paths (empty array if cancelled). */
  openFileDialog(options?: OpenFileDialogOptions): Promise<string[]>
  /** Show a native desktop notification. */
  showNotification(options: NotificationOptions): void
  /**
   * Open a URL in the OS default browser (or the registered handler for its
   * scheme — http/https → browser, mailto: → mail client, slack:// → Slack).
   * Returns true if the OS opened it successfully. Mirrors Electrobun
   * `dist/api/bun/core/Utils.ts:openExternal`.
   */
  openExternal(url: string): boolean
  /** Graceful native shutdown (stops the event loop and force-exits). */
  quit(): void
}

/**
 * The application event emitter. Reachable ONLY through the default export — Electrobun's
 * `dist/api/bun/index.ts` puts `events` on the default object and does not re-export it by name.
 *
 * `before-quit` is emitted SYNCHRONOUSLY from `Utils.quit()`, and Electrobun aborts the quit when
 * a listener sets `response = { allow: false }`. That veto is the only asynchronous affordance in
 * the quit sequence — see `src/gui/quit-gate.ts`.
 */
declare const Electrobun: {
  readonly events: {
    on(
      name: "before-quit",
      handler: (event: { response: { allow: boolean } }) => void,
    ): void
  }
}

export default Electrobun

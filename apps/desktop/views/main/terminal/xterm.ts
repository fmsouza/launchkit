import { ClipboardAddon } from "@xterm/addon-clipboard"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal } from "@xterm/xterm"

/**
 * Narrow structural surface of xterm's `Terminal` that the terminal hook
 * consumes. Kept here (not coupled to the concrete class) so the hook stays
 * testable via an injected constructor.
 */
export interface XtermTerminal {
  readonly element: HTMLElement | undefined
  loadAddon(addon: unknown): void
  open(parent: HTMLElement): void
  write(data: string): void
  onData(handler: (data: string) => void): void
  dispose(): void
}

export interface XtermFitAddon {
  fit(): void
  proposeDimensions?(): { cols: number; rows: number } | undefined
}

/** Statically-bundled xterm constructors + optional addons. */
export interface XtermModules {
  readonly Terminal: new (opts: object) => XtermTerminal
  readonly FitAddon: new () => XtermFitAddon
  readonly WebglAddon: new () => unknown
  readonly ClipboardAddon: new () => unknown
  readonly SearchAddon: new () => unknown
}

/**
 * Resolve the xterm renderer modules.
 *
 * IMPORTANT: these MUST be static ESM imports. The webview is bundled with
 * Bun's `target: "browser"` bundler, which has no runtime `require`. A dynamic
 * `require(specifier)` compiles to a stub that throws "Dynamic require of … is
 * not supported", so the xterm graph would never be bundled and the pane would
 * report "Terminal renderer unavailable". Static imports let the bundler
 * include the xterm graph in the webview's `app.js`. See `xterm.test.ts`.
 */
export const loadXterm = (): XtermModules => ({
  Terminal: Terminal as unknown as new (opts: object) => XtermTerminal,
  FitAddon: FitAddon as unknown as new () => XtermFitAddon,
  WebglAddon: WebglAddon as unknown as new () => unknown,
  ClipboardAddon: ClipboardAddon as unknown as new () => unknown,
  SearchAddon: SearchAddon as unknown as new () => unknown,
})

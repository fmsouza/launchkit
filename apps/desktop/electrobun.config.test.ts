import { describe, expect, it } from "bun:test"

import config from "./electrobun.config"

describe("electrobun.config macOS signing", () => {
  it("enables codesign so channel builds are signed", () => {
    expect(config.build.mac.codesign).toBe(true)
  })

  it("enables notarization so channel builds are notarized + stapled", () => {
    expect(config.build.mac.notarize).toBe(true)
  })
})

/**
 * Regression guard for the webview's browser bundle.
 *
 * The React webview (`views/main/app.tsx`) is bundled with `target: "browser"`. It imports the
 * PURE terminal protocol (`isTerminalOutbound`, schemas, types) from `@spectrum/pty`, whose barrel
 * also re-exports the Bun-native PTY spawner (`bun-ffi-pty.ts`). That module lazily `require`s
 * `bun:ffi` and `node:fs`, neither of which exists in a browser bundle. Without declaring them
 * external, Bun tries to resolve them and the webview build fails. Declaring them external lets Bun
 * tree-shake the unused native code out of the browser bundle entirely.
 *
 * The behavioral proof lives in the desktop smoke (`bun run --filter spectrum smoke`, which builds
 * the bundle and launches it). This guard locks the config declaration so the fix can't be silently
 * removed — a programmatic `Bun.build` here cannot resolve the workspace `@spectrum/*` packages the
 * way the electrobun CLI build does, so it would be a false signal rather than a real check.
 */
describe("electrobun.config webview browser bundle", () => {
  it("declares bun:ffi + node:fs external so the browser bundle never pulls native PTY code", () => {
    const view = config.build.views.main as {
      readonly entrypoint: string
      readonly external?: readonly string[]
    }
    expect(view.external ?? []).toContain("bun:ffi")
    expect(view.external ?? []).toContain("node:fs")
  })
})

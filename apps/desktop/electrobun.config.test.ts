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
 * also re-exports the Node-only `node-pty` adapters. Without declaring `node-pty` external for the
 * browser build, Bun eagerly follows the barrel's `require("node-pty")` into `child_process` and
 * the webview build fails ("Browser build cannot require() Node.js builtin: child_process").
 * Declaring `node-pty` external lets Bun tree-shake the unused native code out of the browser
 * bundle entirely.
 *
 * The behavioral proof lives in the desktop smoke (`bun run --filter spectrum smoke`, which builds
 * the bundle and launches it). This guard locks the config declaration so the fix can't be silently
 * removed — a programmatic `Bun.build` here cannot resolve the workspace `@spectrum/*` packages the
 * way the electrobun CLI build does, so it would be a false signal rather than a real check.
 */
describe("electrobun.config webview browser bundle", () => {
  it("declares node-pty external so the browser bundle never pulls the native addon", () => {
    const view = config.build.views.main as {
      readonly entrypoint: string
      readonly external?: readonly string[]
    }
    expect(view.external ?? []).toContain("node-pty")
  })
})

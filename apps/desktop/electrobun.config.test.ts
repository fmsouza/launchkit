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

/**
 * Regression guard for the packaged-GUI startup crash.
 *
 * Electrobun bundles its own Bun runtime and defaults to a pinned version
 * (`BUN_VERSION` in its `dist/api/shared/bun-version.ts`). Without an explicit
 * `build.bunVersion` override, the CLI uses that default — which at Electrobun
 * 1.18.x is Bun 1.3.13. The packaged `bun` 1.3.13 hits a JSC heap-helper
 * `RELEASE_ASSERT` (`EXC_BREAKPOINT` / `brk 1` on the "Heap Helper Thread")
 * ~1.7s after launch, mid-first-IPC-message — a hard, uncatchable crash that
 * never reproduces in dev (dev runs `bun@1.3.14` via the root `packageManager`
 * pin). The dev environment's 1.3.14 is the proven-good runtime, so we pin the
 * bundle to it explicitly. This lock prevents the override from silently
 * disappearing and shipping the crashing default again.
 */
describe("electrobun.config bundled bun runtime", () => {
  it("pins build.bunVersion to a non-crashing runtime (>= 1.3.14, matching dev)", () => {
    const version = config.build.bunVersion
    expect(typeof version).toBe("string")
    const [major, minor, patch] = (version as string)
      .split(".")
      .map((n) => Number.parseInt(n, 10))
    expect(major).toBe(1)
    expect(minor).toBe(3)
    expect(patch).toBeGreaterThanOrEqual(14)
  })
})

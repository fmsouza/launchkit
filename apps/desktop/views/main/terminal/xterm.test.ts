import { describe, expect, it } from "bun:test"

/**
 * The webview is bundled with Bun's `target: "browser"` bundler, which has no
 * runtime `require`. A dynamic `require(specifier)` therefore compiles to a
 * stub that throws `Dynamic require of "..." is not supported`, and the xterm
 * graph never gets bundled — which is exactly why opening the terminal showed
 * "Terminal renderer unavailable" in real builds (bun:test, by contrast, HAS
 * `require`, so a plain unit test cannot catch this).
 *
 * This test bundles the loader the way Electrobun bundles the webview and
 * asserts xterm is statically bundled (no throwing dynamic-require stub, real
 * xterm code present).
 */
describe("xterm loader browser bundle", () => {
  it("statically bundles xterm for target:browser with no unsupported dynamic require", async () => {
    const result = await Bun.build({
      entrypoints: [new URL("./xterm.ts", import.meta.url).pathname],
      target: "browser",
    })
    expect(result.success).toBe(true)
    const artifact = result.outputs[0]
    if (artifact === undefined) throw new Error("expected a build artifact")
    const code = await artifact.text()

    // No throwing dynamic-require stub for xterm in the browser bundle.
    expect(code).not.toContain('Dynamic require of "@xterm')
    // The real xterm + addon-fit code must be statically bundled (not merely
    // referenced by specifier string). `proposeDimensions` is part of the
    // FitAddon API and only appears when the library is actually bundled.
    expect(code).toContain("proposeDimensions")
  })
})

import { describe, expect, it } from "bun:test"

// Regression guard for the stylesheet wiring: the CSS must be (a) linked from
// `index.html` in the correct cascade order, (b) copied next to the bundled `app.js`
// by the Electrobun build, and (c) contain the key structural selectors.

const indexHtml = await Bun.file(
  new URL("./index.html", import.meta.url),
).text()

const electrobunConfig = await Bun.file(
  new URL("../../electrobun.config.ts", import.meta.url),
).text()

const PARTIALS = [
  "fonts.css",
  "tokens.css",
  "base.css",
  "controls.css",
  "primitives.css",
  "shell.css",
  "sessions-master.css",
  "sessions-detail.css",
  "run-view.css",
  "forms.css",
  "modal.css",
  "lists.css",
  "page.css",
  // Vendored xterm base stylesheet — required for the internal terminal pane to
  // render with correct row/viewport layout. Linked last (it styles independent
  // `.xterm` elements) and shipped same-origin so CSP `style-src 'self'` allows it.
  "xterm.css",
] as const

describe("views/main stylesheet partials wiring", () => {
  it("links every partial from index.html in styles/ in cascade order", () => {
    const positions = PARTIALS.map((p) =>
      indexHtml.indexOf(`href="./styles/${p}"`),
    )
    for (const [i, pos] of positions.entries())
      expect(pos, `${PARTIALS[i]} must be linked`).toBeGreaterThan(-1)
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted) // links appear in declared order
  })

  it("links the partials before the module script so styles apply on first paint", () => {
    const lastLink = Math.max(
      ...PARTIALS.map((p) => indexHtml.indexOf(`href="./styles/${p}"`)),
    )
    expect(lastLink).toBeLessThan(indexHtml.indexOf('src="./app.js"'))
  })

  it("copies every partial in the Electrobun build so they ship next to app.js", () => {
    // Normalise the config source so biome's line-wrapping of long keys doesn't
    // affect the check (both key and value must appear regardless of wrapping).
    const flat = electrobunConfig.replace(/\s+/g, " ")
    for (const p of PARTIALS)
      expect(flat).toContain(
        `"views/main/styles/${p}": "views/main/styles/${p}"`,
      )
  })

  it("ships the brand tray icon next to app.js via build.copy", () => {
    const flat = electrobunConfig.replace(/\s+/g, " ")
    expect(flat).toContain(
      '"views/main/spectrum-tray.png": "views/main/spectrum-tray.png"',
    )
  })

  it("still ships the post-redesign shell + sessions detail markers", async () => {
    const shell = await Bun.file(
      new URL("./styles/shell.css", import.meta.url),
    ).text()
    const sessions = await Bun.file(
      new URL("./styles/sessions-detail.css", import.meta.url),
    ).text()
    expect(shell).toContain('nav[aria-label="Primary"]')
    expect(sessions).toContain(".lk-sessions-detail")
  })

  it("ships the self-hosted Geist woff2 next to app.js via build.copy", () => {
    const flat = electrobunConfig.replace(/\s+/g, " ")
    for (const f of ["Geist-Variable.woff2", "GeistMono-Variable.woff2"])
      expect(flat).toContain(`"views/main/fonts/${f}": "views/main/fonts/${f}"`)
  })

  it("links fonts.css before tokens.css so @font-face is registered first", () => {
    expect(indexHtml.indexOf('href="./styles/fonts.css"')).toBeLessThan(
      indexHtml.indexOf('href="./styles/tokens.css"'),
    )
  })

  it("guards key structural selectors so CSS stays in sync with the shell DOM", async () => {
    const tokens = await Bun.file(
      new URL("./styles/tokens.css", import.meta.url),
    ).text()
    const controls = await Bun.file(
      new URL("./styles/controls.css", import.meta.url),
    ).text()
    const shell = await Bun.file(
      new URL("./styles/shell.css", import.meta.url),
    ).text()
    const sessionsMaster = await Bun.file(
      new URL("./styles/sessions-master.css", import.meta.url),
    ).text()
    const sessionsDetail = await Bun.file(
      new URL("./styles/sessions-detail.css", import.meta.url),
    ).text()

    const runView = await Bun.file(
      new URL("./styles/run-view.css", import.meta.url),
    ).text()
    expect(tokens).toContain("--sp-master-w")
    expect(tokens).toContain('[data-theme="light"]')
    expect(tokens).not.toContain("prefers-color-scheme")
    expect(controls).toContain("[data-variant=")
    expect(shell).toContain(".lk-shell")
    expect(shell).toContain("[data-app-icon]")
    expect(shell).toContain('nav[aria-label="Primary"]')
    expect(sessionsMaster).toContain(".lk-session-row")
    expect(sessionsDetail).toContain(".lk-sessions-detail")
    expect(runView).toContain(".lk-run-view")
    expect(runView).toContain(".lk-sub-runner-pane")
    expect(runView).toContain(".lk-timeline")
  })
})

import { readFileSync } from "node:fs"
import type { ElectrobunConfig } from "electrobun"

/**
 * Electrobun build configuration for the Spectrum binary (Electrobun v1.18.x schema).
 *
 * - `build.bun.entrypoint` → the main (Bun) process; bundled to `bun/index.js`. The Electrobun
 *   launcher loads that file via `new Worker(...)`, where `import.meta.main` is always `false`, so
 *   the entry (`src/index.ts`) must run startup unconditionally — it is a thin shell over the
 *   tested `main`/`buildRealDeps` (see src/main.ts) that calls
 *   `runApp(detectMode(argv), argv, buildRealDeps(...))`.
 * - `build.views.main.entrypoint` → the React webview; bundled (target: browser) to
 *   `views/main/app.js`, which `views/main/index.html` references as `./app.js`.
 * - `build.copy` → ships the CSP-hardened `index.html` and the split stylesheet partials under
 *   `views/main/styles/` (tokens, base, controls, primitives, shell, sessions-master,
 *   sessions-detail, forms, modal, lists, page) next to the bundled `app.js` so the
 *   `views://main/index.html` URL (see `gui/window.ts`) resolves to local, bundled assets only —
 *   each partial is linked same-origin under `style-src 'self'`.
 * - `build.mac.createDmg: true` + `codesign`/`notarize` → emit a signed + notarized + stapled DMG
 *   installer for macOS channel builds. Dev builds (`buildEnvironment === "dev"`) auto-skip signing.
 * - `build.watch`/`build.watchIgnore` → extra paths for `electrobun dev --watch` (rebuild + relaunch
 *   on change). The default watch only covers this app's `src/` + `views/`; we add the workspace
 *   `packages/` so editing a `@spectrum/*` package (proxy, harnesses, drivers, …) also live-reloads.
 *   Test files are ignored so running/saving tests doesn't trigger app rebuilds.
 */
// Single source of truth for the app version: the monorepo root package.json
// (bumped by the release process). Read at build time so the bundled version.json
// — and thus the in-app "Current version" — always matches the released version.
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string }

// Canary builds inject the canary build number via SPECTRUM_CANARY_BUILD (set
// by canary.yml's `version` job) so the running build knows its own canary.N —
// the version string then flows through version.json → localInfo.version() →
// UpdateState.currentVersion → the UI unchanged. Stable/release.yml and dev
// builds leave this unset, so the version stays the plain package.json version.
const canaryBuildEnv = process.env.SPECTRUM_CANARY_BUILD
const canaryBuild =
  canaryBuildEnv !== undefined && Number.isInteger(Number(canaryBuildEnv))
    ? Number(canaryBuildEnv)
    : null
const appVersion =
  canaryBuild !== null
    ? `${rootPackage.version}-canary.${canaryBuild}`
    : rootPackage.version

const config = {
  app: {
    name: "Spectrum",
    identifier: "dev.spectrum.app",
    version: appVersion,
  },
  // Auto-update distribution. `baseUrl` is the STABLE rolling-tag URL that CI
  // force-moves on every release, so the running app always finds the newest
  // per-channel `<channel>-<os>-<arch>-update.json` + patch + tarball there.
  // Channel lives in the artifact filename, so one baseUrl serves both channels.
  release: {
    baseUrl: "https://github.com/fmsouza/spectrum/releases/download/updates",
    generatePatch: true,
  },
  build: {
    bun: { entrypoint: "src/index.ts" },
    // Override the bundled Bun runtime. Electrobun downloads a per-platform official Bun release
    // (https://github.com/oven-sh/bun/releases/download/bun-v<version>/…) and uses it as the
    // `Contents/MacOS/bun` the launcher execs. Without it, the CLI falls back to Electrobun's
    // pinned default (`BUN_VERSION` in its `dist/api/shared/bun-version.ts`) — Bun 1.3.13 at
    // Electrobun 1.18.x, which hits a JSC heap-helper RELEASE_ASSERT (`EXC_BREAKPOINT` / `brk 1`
    // on the "Heap Helper Thread") ~1.7s after a packaged launch, mid-first-IPC-message: a hard,
    // uncatchable startup crash that never reproduces in dev (dev runs `bun@1.3.14` via the root
    // `packageManager` pin). Pin the bundle to 1.3.14 — the proven-good runtime — so channel builds
    // don't ship the crashing 1.3.13. Bump this floor when adopting a newer proven Bun; the config
    // test guards it.
    bunVersion: "1.3.14",
    views: {
      main: {
        entrypoint: "views/main/app.tsx",
        // The webview's `target: "browser"` bundle imports only the PURE terminal protocol
        // (`isTerminalOutbound`, schemas, types) from `@spectrum/pty`, whose barrel also
        // re-exports the Bun-native PTY spawner (`bun-ffi-pty.ts`). That module lazily `require`s
        // `bun:ffi` and `node:fs` — both unavailable in a browser bundle — so we mark them
        // external. Without this the browser bundler tries to resolve them and the webview build
        // fails; marking them external lets Bun tree-shake the unused native code out of the
        // webview bundle entirely.
        external: ["bun:ffi", "node:fs"],
      },
    },
    copy: {
      "views/main/index.html": "views/main/index.html",
      "views/main/styles/fonts.css": "views/main/styles/fonts.css",
      "views/main/fonts/Geist-Variable.woff2":
        "views/main/fonts/Geist-Variable.woff2",
      "views/main/fonts/GeistMono-Variable.woff2":
        "views/main/fonts/GeistMono-Variable.woff2",
      "views/main/styles/tokens.css": "views/main/styles/tokens.css",
      "views/main/styles/base.css": "views/main/styles/base.css",
      "views/main/styles/controls.css": "views/main/styles/controls.css",
      "views/main/styles/primitives.css": "views/main/styles/primitives.css",
      "views/main/styles/shell.css": "views/main/styles/shell.css",
      "views/main/styles/sessions-master.css":
        "views/main/styles/sessions-master.css",
      "views/main/styles/sessions-detail.css":
        "views/main/styles/sessions-detail.css",
      "views/main/styles/run-view.css": "views/main/styles/run-view.css",
      "views/main/styles/forms.css": "views/main/styles/forms.css",
      "views/main/styles/modal.css": "views/main/styles/modal.css",
      "views/main/styles/lists.css": "views/main/styles/lists.css",
      "views/main/styles/page.css": "views/main/styles/page.css",
      "views/main/styles/xterm.css": "views/main/styles/xterm.css",
      "views/main/spectrum-favicon.svg": "views/main/spectrum-favicon.svg",
      "views/main/favicon.ico": "views/main/favicon.ico",
      "views/main/spectrum-tray.png": "views/main/spectrum-tray.png",
    },
    // `icons` points at the macOS .iconset (built from the brand squircle icon); Electrobun
    // runs `iconutil` at build time to emit AppIcon.icns (CFBundleIconFile) into the bundle.
    // codesign + notarize the macOS channel builds (`build:stable`/`build:canary`). Electrobun
    // only signs when buildEnvironment !== "dev" on a macOS host, so local `bun run start`/`dev`/
    // `build` and the CI dev/smoke build auto-skip — and require no Apple credentials. CI injects
    // the Developer ID identity + App Store Connect API key via the `macos-codesign-setup`
    // composite action (env: ELECTROBUN_DEVELOPER_ID, ELECTROBUN_APPLEAPIKEYPATH/KEY/ISSUER).
    // Default entitlements (allow-jit, allow-unsigned-executable-memory, disable-library-validation)
    // are correct for the Bun runtime under the hardened runtime notarization requires.
    mac: {
      createDmg: true,
      icons: "icon.iconset",
      codesign: true,
      notarize: true,
    },
    linux: { bundleCEF: true, defaultRenderer: "cef" },
    win: {},
    // Extra paths `electrobun dev --watch` watches for rebuilds (the monorepo's `packages/`
    // feed the build, so a change there must rebuild the app). `watchIgnore` excludes tests
    // so editing a `.test.ts` doesn't relaunch. Both are honored by the CLI at runtime; they
    // live inside the `satisfies ElectrobunConfig` object so they're compile-time validated
    // against the local type shim (`src/types/electrobun-root.d.ts`).
    watch: ["../../packages"],
    watchIgnore: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.js"],
  },
} satisfies ElectrobunConfig

export default config

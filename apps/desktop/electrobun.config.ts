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
    views: {
      main: { entrypoint: "views/main/app.tsx" },
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
  },
} satisfies ElectrobunConfig

// `build.watch`/`build.watchIgnore` drive `electrobun dev --watch`, and `build.views.main.external`
// passes through to Bun.build — all are honored by the CLI at runtime but absent from the v1.18.1
// `ElectrobunConfig` type. Attach them AFTER the `satisfies` check so the core config is still
// type-validated while these extra, runtime-only keys pass through.
//
// `external: ["node-pty"]` keeps the native Node addon out of the webview's `target: "browser"`
// bundle. The webview imports only the PURE terminal protocol (`isTerminalOutbound`, schemas, types)
// from `@spectrum/pty`, whose barrel also re-exports the node-pty adapters; without this the browser
// bundler eagerly follows `require("node-pty")` into `child_process` and fails. Marking it external
// lets Bun tree-shake the unused native code out of the webview bundle entirely.
export default {
  ...config,
  build: {
    ...config.build,
    views: {
      ...config.build.views,
      main: { ...config.build.views.main, external: ["node-pty"] },
    },
    watch: ["../../packages"],
    watchIgnore: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.js"],
  },
}

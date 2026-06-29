/**
 * Local type surface for the Electrobun **root** export (`electrobun`), used only by
 * `electrobun.config.ts` for the `ElectrobunConfig` type. See `electrobun-bun.d.ts` for the full
 * rationale: Electrobun ships non-strict-compiling `.ts` source, so we map `"electrobun"` onto this
 * declaration via the desktop `tsconfig.json` `paths` (type resolution only). This is a SUBSET of
 * the real `ElectrobunConfig` — the authoritative validator is `electrobun build` itself.
 *
 * Keep this in sync with the keys `electrobun.config.ts` actually sets. Each key declared here is
 * type-checked at the `satisfies ElectrobunConfig` site, so adding a key here grants free compile-time
 * validation (catches typos that would otherwise silently fall back to Electrobun's default).
 */

export interface ElectrobunConfig {
  app: {
    name: string
    identifier: string
    version: string
    description?: string
  }
  build?: {
    bun?: { entrypoint?: string }
    /**
     * Override the bundled Bun runtime version (semver, e.g. "1.3.14"). The Electrobun CLI
     * downloads the matching official Bun release per platform and uses it as `Contents/MacOS/bun`
     * instead of the version bundled with this Electrobun release. See `electrobun.config.ts`
     * for the crash that motivated pinning this. @default Electrobun's pinned `BUN_VERSION`.
     */
    bunVersion?: string
    views?: {
      [viewName: string]: {
        entrypoint: string
        /**
         * Passthrough to `Bun.build`'s `external` option (used to keep `bun:ffi`/`node:fs` out of
         * the browser bundle). Declared here so the config's `external` key is type-checked.
         */
        external?: string[]
      }
    }
    copy?: { [sourcePath: string]: string }
    buildFolder?: string
    targets?: string
    /** Extra paths `electrobun dev --watch` watches for rebuilds. */
    watch?: string[]
    /** Glob patterns excluded from the watch trigger. */
    watchIgnore?: string[]
    mac?: {
      codesign?: boolean
      createDmg?: boolean
      notarize?: boolean
      // Path to a .iconset folder / .icon file; Electrobun runs iconutil/actool at build
      // time to emit AppIcon.icns (CFBundleIconFile). @default "icon.iconset"
      icons?: string
    }
    linux?: { bundleCEF?: boolean; defaultRenderer?: "native" | "cef" }
    win?: { bundleCEF?: boolean; defaultRenderer?: "native" | "cef" }
  }
  /** Release and distribution configuration for auto-updates. */
  release?: {
    /** Base URL for artifact distribution (e.g. GitHub Releases rolling tag). */
    baseUrl?: string
    /** Generate delta patch files by diffing against the previous release. @default true */
    generatePatch?: boolean
  }
}

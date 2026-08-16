# @spectrum/extensions

Versioned extension manifest schema for provider plugins.

## Responsibility
Defines the on-disk shape of a Spectrum extension manifest and validates it: an api-version
gate (`spectrum.dev/v<major>`, refused if the major is newer than this Spectrum supports)
checked *before* shape validation, then a strict-root/passthrough-`contributes` zod schema.
Nothing in this package spawns a process or touches the filesystem — that arrives in a later
task that consumes `parseManifest`.

## Public API
- `ExtensionManifestSchema` / `ExtensionManifest` — the manifest shape (root is `.strict()`;
  `contributes` is `.passthrough()` so a manifest from a future Spectrum still parses)
- `parseManifest(raw): Result<ParsedManifest, PluginError>` — api-version gate, then shape,
  then reports which `contributes` keys were present but unknown (`ignoredContributions`)
- `KNOWN_CONTRIBUTION_KEYS` — the `contributes` keys this Spectrum understands (`["providers"]`)
- `SUPPORTED_API_MAJOR`, `parseApiVersion`, `isSupportedApiVersion`
- `ProviderContributionSchema` — stub (`z.unknown()`) pending the provider-contribution shape
- `PluginError` — the complete extension error union; declared complete here so no later
  plan adds variants to it

## Local invariants
- Api-version is checked *before* shape, so a manifest from a future Spectrum reports
  "needs a newer Spectrum" instead of a confusing schema error.
- The manifest root is strict (typos are loud); `contributes` passes unknown keys through
  untouched rather than rejecting them, so an older Spectrum can still install a manifest
  written for a newer one and simply contribute less.
- Zero IO. `parseManifest` takes `unknown` and returns `Result`; it never throws.

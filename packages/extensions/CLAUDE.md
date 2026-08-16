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
- `ProviderContributionSchema` / `ProviderContribution` — one LLM provider a plugin
  contributes: a descriptor (config/secret fields, reasoning, discovery, actions — mirrors
  `@spectrum/providers`' builtin shape) + a transport (`kind: "http"`, `wire`, an optional
  `launch` for a Spectrum-spawned server). A contribution declaring no `actions` defaults to
  `defaultActions` from `@spectrum/providers`, same as a builtin.
- `PluginLaunchSchema` / `PluginLaunch` — how a plugin's provider server is launched as a
  local child process: `command`, `args`, `envTemplate`, optional `cwd`, `healthPath`
  (default `/models`), `readyTimeoutMs` (default 10 000)
- `RUNTIME_TOKENS` — the fixed template tokens every launch may use regardless of what the
  contribution declares: `port`, `host`, `baseUrl`, `hostToken`
- `allowedTokensFor(contribution): ReadonlySet<string>` — RUNTIME_TOKENS plus the
  contribution's own declared secret and config field names; computed per contribution,
  unlike harnesses' fixed token list
- `validateContributionTemplates(contribution): Result<void, PluginError>` — rejects any
  `{{token}}` in the launch's env or args that isn't in `allowedTokensFor`
- `renderPluginEnv(launch, values)` / `renderPluginArgs(launch, values)` — substitute
  `{{token}}` in a launch's env/args; a token with no supplied value renders to `""`
  (rendering assumes `validateContributionTemplates` already ran — it never errors)
- `PluginError` — the complete extension error union; declared complete here so no later
  plan adds variants to it

## Local invariants
- Api-version is checked *before* shape, so a manifest from a future Spectrum reports
  "needs a newer Spectrum" instead of a confusing schema error.
- The manifest root is strict (typos are loud); `contributes` passes unknown keys through
  untouched rather than rejecting them, so an older Spectrum can still install a manifest
  written for a newer one and simply contribute less.
- Zero IO. `parseManifest` takes `unknown` and returns `Result`; it never throws.
- `ProviderContributionSchema`'s `reasoning`/`discovery` fields validate against
  `ReasoningSupportSchema`/`DiscoverySchema` from `@spectrum/providers` — zod counterparts to
  that package's hand-written `ReasoningSupport`/`DiscoverySpec` types, pinned to them by a
  compile-time assertion so the two can't silently drift.
- Template validation and rendering are split: `validateContributionTemplates` is the only
  place unknown tokens are rejected; `renderPluginEnv`/`renderPluginArgs` are pure
  substitution and never fail, so callers must validate before spawning.

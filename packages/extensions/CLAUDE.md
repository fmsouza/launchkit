# @spectrum/extensions

Versioned extension manifest schema for provider plugins, plus the registry and file source
that read the installed set off disk.

## Responsibility
Defines the on-disk shape of a Spectrum extension manifest and validates it: an api-version
gate (`spectrum.dev/v<major>`, refused if the major is newer than this Spectrum supports)
checked *before* shape validation, then a strict-root/passthrough-`contributes` zod schema.
On top of that, the registry loads every installed extension, rejects duplicate ids, validates
every provider contribution's launch templates, and projects enabled contributions onto
`@spectrum/providers` descriptors.

Manifest parsing, template validation, and descriptor projection are PURE. Filesystem access
is confined to the one adapter (`createDirExtensionFileSource`) behind the `ExtensionFileSource`
seam; nothing in this package spawns a process (that is `@spectrum/provider-host`).

## Public API
### Manifest + contribution schemas (pure)
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
- `PluginError` — the complete extension error union; declared complete here so no later
  plan adds variants to it. `invalid-manifest` and `unsupported-api-version` each carry an
  OPTIONAL `id`, attached by whichever caller knows the extension directory (`parseManifest`
  is pure and never sees one; `ExtensionRegistry.list()` does and attaches it). A field on an
  existing member is not a new member — and without it, `list()` failing the whole batch on
  one bad manifest leaves every caller unable to say WHICH extension is broken.

### Launch templates (pure)
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

### Descriptor projection (pure)
- `descriptorFromContribution(contribution): ProviderDescriptor` — the runtime descriptor the
  provider registry consumes. `key` is `plugin:<contribution id>`; the config schema is DERIVED
  from the declared field specs (JSON cannot carry a zod schema); a placeholder api key is
  always declared because `@ai-sdk/openai` throws without a non-empty string.

### Registry
- `ExtensionRegistry` / `createExtensionRegistry({ fileSource, logger? })` with
  `list(): Promise<Result<readonly LoadedExtension[], PluginError>>` and
  `providerDescriptors(enabledIds): Promise<Result<readonly ProviderDescriptor[], PluginError>>`
- `LoadedExtension = { manifest; ignoredContributions; dir }`

### File source (the ONE effectful seam)
- `ExtensionFileSource` — `listExtensions()`, `readExtension(id)`, `removeExtension(id)`,
  `extensionDir(id: PluginId)` (pure and synchronous; takes a BRANDED id so the traversal
  guard is structural — do not weaken it back to `string`)
- `ExtensionEntry = { id; raw }` — still-unvalidated manifest bytes tagged with their directory id
- `createDirExtensionFileSource(root, linkMap)` — the real adapter: `readdir`/`stat`/`rm` +
  `Bun.file`. Each subdirectory of `root` is one extension id, unless `linkMap` overrides that
  id to an absolute directory read LIVE instead (the `link` install mode). No symlinks — they
  need elevation on Windows.
- `createInMemoryExtensionFileSource(entries, failure?)` — the fake every test uses

## Local invariants
- Api-version is checked *before* shape, so a manifest from a future Spectrum reports
  "needs a newer Spectrum" instead of a confusing schema error.
- The manifest root is strict (typos are loud); `contributes` passes unknown keys through
  untouched rather than rejecting them, so an older Spectrum can still install a manifest
  written for a newer one and simply contribute less.
- `parseManifest` (via `ExtensionManifestSchema`'s `ContributesSchema`) refuses a manifest
  whose OWN `contributes.providers` declares the same contribution id more than once. This is
  the primary defense against a self-colliding manifest bricking `list()`: `list()` dedupes
  contribution ids in one pass ACROSS the whole installed set, so a self-colliding manifest
  that ever reached disk would make every other installed extension fail to load too, not just
  itself. Catching it here — the one seam every manifest source passes through (git clone,
  copy, link, and a hand-placed directory `@spectrum/extensions/installer` never touches) —
  covers sources `installer.ts`'s own pre-install check cannot see. Reports exactly one issue
  regardless of how many duplicates exist (`break`s after the first) — the loop runs over
  attacker-controlled content, and an issue per duplicate is an unbounded `PluginError.detail`.
- `parseManifest` takes `unknown` and returns `Result`; it never throws. All IO lives in
  `adapters.ts` behind `ExtensionFileSource` and returns `Result` too.
- `ProviderContributionSchema`'s `reasoning`/`discovery` fields validate against
  `ReasoningSupportSchema`/`DiscoverySchema` from `@spectrum/providers` — zod counterparts to
  that package's hand-written `ReasoningSupport`/`DiscoverySpec` types, pinned to them by a
  compile-time assertion so the two can't silently drift.
- Template validation and rendering are split: `validateContributionTemplates` is the only
  place unknown tokens are rejected; `renderPluginEnv`/`renderPluginArgs` are pure
  substitution and never fail, so callers must validate before spawning.
- `list()` refuses duplicate MANIFEST ids and duplicate provider-CONTRIBUTION ids ACROSS
  DIFFERENT extensions in the whole installed set (a single manifest's own self-collision is
  caught earlier, by `parseManifest`, above — `list()` never sees that case, since a
  self-colliding manifest fails to parse before `list()`'s own scan runs). The contribution id
  is the security-relevant one: it becomes `plugin:<id>` and is what `@spectrum/provider-host`
  keys on when it spawns a launch block, so two extensions claiming one contribution id would
  make "whose command gets spawned" depend on directory-read order. Refusing the whole batch
  beats picking a winner.
- A directory id and the manifest id it declares must agree, or `dir` would point somewhere the
  manifest never claimed — silently breaking uninstall-by-id.
- A `source-unavailable` entry (a dead linked path) is logged and SKIPPED; an invalid manifest,
  an unsupported api version, or a duplicate id fails the whole `list()`.
- **`GitClient.checkoutFetchHead` must never be called on an unvalidated `FETCH_HEAD`.**
  `ExtensionInstaller.update` fetches, reads the candidate manifest out of `FETCH_HEAD`
  (`showFetchHead`), validates it, and only then checks it out. This is an ORDERING invariant
  the seam no longer enforces for you: the three operations used to be one `fetchCheckout`
  method, which made the wrong order structurally impossible but also made validate-before-
  adopt impossible, so it was split. Adopting an unvalidated commit is not a local failure —
  `list()` refuses the whole installed set on an invalid manifest or a duplicate contribution
  id, so one bad upstream commit left checked out makes every OTHER installed extension
  disappear, and `update` cannot recover it (the recorded ref is unchanged, so it re-fetches
  the same commit). There is one caller today, pinned by ordering tests in `installer.test.ts`
  and `installer.integration.test.ts`; a second caller must reproduce the same order.
- **`redactUrlCredentials`'s rules mirror `planInstall`'s refusals, per url shape.** Whatever
  the planner calls a credential (any `https://` userinfo; a PASSWORD in an `ssh://` or
  scp-style userinfo) the redactor blanks; whatever it calls a bare username (`ssh://git@host`,
  `git@host:path`) the redactor leaves intact, so an error message stays legible. Both modules
  share one `SCP_STYLE` (declared in `redact.ts`) rather than each carrying its own shape
  regex. Changing one side without the other either leaks a secret or blanks a non-secret.
- `providerDescriptors` filters by `enabledIds`. That filter is NOT the whole enforcement of
  `enabled`: `list()` reports everything installed, so every consumer that can reach a
  contribution's `launch` block must apply `enabled` itself (`@spectrum/provider-host` takes an
  injected `isEnabled` for exactly this).

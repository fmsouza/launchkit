# @spectrum/providers

**Responsibility:** the provider catalog — one declarative `ProviderDescriptor` per `SdkProvider` (config/secret field specs, per-provider zod config schema, SDK-option mapping, discovery spec) + the presentational `ProviderCatalogEntry` projection + `validateProviderConfig`.

**Public API (barrel `src/index.ts`):** `ProviderDescriptor`/`ConfigFieldSpec(Schema)`/`SecretFieldSpec(Schema)`/`ProviderCatalogEntry(Schema)`/`ProviderAction(Schema)`/`ApiKeyMapping`/`DiscoverySpec`/`DiscoverySchema`/`SdkMapping`/`ProviderConfigError`/`ReasoningSupport`/`ReasoningSupportSchema`/`ReasoningShape`; `getDescriptor`, `listDescriptors`, `toCatalogEntry`, `providerCatalog`, `defaultActions`; `validateProviderConfig`; `createProviderRegistry`/`ProviderRegistry`. `DiscoverySchema`/`ReasoningSupportSchema` are zod counterparts to the hand-written `DiscoverySpec`/`ReasoningSupport` types (used by `@spectrum/extensions` to validate plugin-contributed descriptors); each type stays authoritative and a compile-time assertion pins the schema to it so they can't drift silently.

**Depends on:** `@spectrum/types`, `@spectrum/utils`, zod.

**Effects owned:** none — pure data + validation. The SDK `import()` lives in `@spectrum/proxy`'s `load-sdk`; this package only DESCRIBES mappings (which option carries the base URL, whether the api key is an option or an `Authorization` header, which config fields map to headers, how to discover models).

**Local rules:** descriptors are total over the `SdkProvider` union (the `Record<SdkProvider, ProviderDescriptor>` + the catalog test pin this — add an entry whenever the enum grows). Secret fields are NAMES only, never values. Base URLs include their version path (`/v1` for OpenAI-compatible, `/api` for Ollama) so the proxy's discovery appends `/models` or `/tags`. `ProviderConfigError` is a structural subset of proxy's `ProxyError` so the proxy re-exports `validateProviderConfig` directly.

# @spectrum/proxy

**Responsibility:** HTTP proxy + inbound adapters + router + AI SDK provider factory + outbound serializers.

**Public API (barrel `src/index.ts`):** startProxy, isProxyRunning, createHandler, createRouter, createProviderFactory, defaultResolveBaseUrl, loadSdk, createRealGateway, the adapters, validateProviderConfig, createNameGenerator, NameGenerator, NameGenError, buildNamePrompt, NAME_PROMPT_MAX, and all public types.

**Depends on:** @spectrum/types, @spectrum/utils, @spectrum/config, @spectrum/secrets

**Effects owned:** http server + outbound network (AI SDK)
— exposed to consumers as injected interfaces; never reached around.

**Local rules:** stream, never buffer; cache provider instances (the injected `resolveBaseUrl` runs BEFORE the cache read and its result is part of the cache key, so a supervised plugin that restarts on a new port never gets served an instance bound to the dead one); loopback-only + key-checked; streamText() is the uniform call for the proxied stream; `createNameGenerator` makes a bounded one-shot `generateText` call (capped at ~32 output tokens, 10s timeout) to AI-name a session — the only non-streaming AI SDK call, kept here because `@spectrum/proxy` owns all AI SDK seams.

Accepts an injected `Logger` (default noop); logs `info` on start/stop (host/port only); on an error Result logs only `{ kind }` — `warn` for client errors (unauthorized/bad-request), `error` for provider/outbound failures; streaming hot path is never logged above `debug`. NEVER logs proxyKey/apiKey/bodies.

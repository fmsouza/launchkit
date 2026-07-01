import { createAppContext } from "@spectrum/runtime-core"
import { createGuiContext, realDeps } from "./composition"
import { buildRealDeps, main } from "./main"

// Electrobun bun-process entrypoint. Bundled to `bun/index.js`, which the Electrobun launcher
// loads via `new Worker(...)`. Inside a Worker `import.meta.main` is `false`, so startup must NOT
// be gated on it — this file runs `main` unconditionally. All decision logic stays in the pure,
// tested `main` / `buildRealDeps` (see main.ts); this is a thin, build-verified shell.
//
// Single-purpose GUI: straight to startProxy + openWindow. argv is ignored (no CLI branch).
await main(
  process.argv,
  buildRealDeps(() => createGuiContext(createAppContext(realDeps))),
)

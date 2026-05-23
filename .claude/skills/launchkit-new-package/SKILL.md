---
name: launchkit-new-package
description: Use when creating a new internal package under packages/
---

# launchkit-new-package

Checklist for creating a new `@launchkit/<name>` package:

1. Create `packages/<name>/` directory.
2. Create `package.json`: name `@launchkit/<name>`, `"type": "module"`, `"private": true`, `"exports": { ".": "./src/index.ts" }`, `"scripts": { "typecheck": "tsc --noEmit", "test": "bun test" }`.
3. Create `tsconfig.json`: extends the right `tooling/tsconfig` preset with `"references"` to dependency packages.
4. Create `src/index.ts` barrel file.
5. Create a co-located smoke test.
6. Add the package to the dependency DAG in `build-plan/02-monorepo/boundaries.md` if new.
7. Create a short `CLAUDE.md` from the template in `build-plan/03-claude-config/package-claude-md.md`.
8. Add the package reference to root `tsconfig.json`.
9. Verify `bun run typecheck`, `bun run lint`, `bun test` all pass.

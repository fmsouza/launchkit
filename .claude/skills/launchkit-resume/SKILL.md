---
name: launchkit-resume
description: Use when starting a LaunchKit implementation session or when asked to "continue building LaunchKit" or "resume implementation"
---

# launchkit-resume

You are resuming work on LaunchKit, a Bun + Electrobun desktop app.

1. Read `build-plan/EXECUTION.md` (the protocol) and `build-plan/PROGRESS.md` (current state).
2. Invoke `using-superpowers`, `test-driven-development`, and either `executing-plans` or `subagent-driven-development`.
3. Pick the first task in `PROGRESS.md` whose status is `todo` and dependencies are all `done`.
4. Open that task's plan file (under `build-plan/04-plans/`). Implement via strict TDD: RED → GREEN → REFACTOR.
5. Run the gate: `bun run typecheck && bun run lint && bun test`. All must pass.
6. Update `PROGRESS.md` (status `done` + commit SHA). Commit with task ID in message.
7. Repeat until no `todo` tasks remain, or report blockers.

See `build-plan/README.md` for the canonical resume prompt.

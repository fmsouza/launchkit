# @spectrum/agent-events

**Responsibility:** The canonical harness-agnostic event vocabulary (zod schemas + inferred types), the `StoredEvent` envelope, and the **pure** runner-tree reducer (`reduce(state, event) → state`) with its view-state types. Zero IO.

**Public API (barrel `src/index.ts`):** `Json`; `UsageSchema`/`Usage`; `ApprovalTargetSchema`/`ApprovalTarget`; `ApprovalDecisionSchema`/`ApprovalDecision`; `PermissionModeSchema`/`PermissionMode`; `CanonicalEventSchema`/`CanonicalEvent`; `StoredEventSchema`/`StoredEvent`; `PlanEntrySchema`/`PlanEntry`; the view-state types (`RunnerStatus`, `MessageItem`, `ReasoningItem`, `ToolCallItem`, `FileChangeItem`, `ApprovalItem`, `PlanItem`, `TimelineItem`, `RunnerState`, `RunState`); `initialRunState`; `reduce`; and a re-export of `RunnerIdSchema`/`RunnerId` from `@spectrum/types` (so the canonical-model package is the single import source for `RunnerId` downstream). `RunnerState.supportedModes` is part of the view-state, projected from the `runner-started.supportedModes` field emitted by the driver on startup. `Usage` additionally carries optional `contextUsed`/`contextSize` (ACP `usage_update`), and the `plan-update` event folds into a `PlanItem` with REPLACE semantics keyed by `planId` — re-emitting the same plan replaces it rather than appending a second card.

**Depends on:** `@spectrum/types`, `@spectrum/utils`, `zod` (external).

**Effects owned:** none — this package is pure. No fs, net, sqlite, clock, or random.

**Local rules:** Types are zod-first (`z.infer`); `CanonicalEventSchema` is the source of truth. The reducer is pure and deterministic: folding a full log yields a state identical to feeding events one at a time (event-sourcing invariant — covered by a test). Opaque JSON fields (`input`, `result`, `data`) are `z.unknown()` / `Json = unknown`. Imported by both backend and UI — never import a store or a driver from here.

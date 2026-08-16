/**
 * Failure modes the process primitives can produce.
 *
 * A structural SUBSET of `@spectrum/harnesses`' `HarnessError` — both variants exist
 * there with identical shapes — so a `Result<T, ProcError>` is directly assignable to a
 * `Result<T, HarnessError>` and the harness package needs no mapping layer.
 */
export type ProcError =
  | { readonly kind: "invalid-command"; readonly detail: string }
  | { readonly kind: "spawn-failed"; readonly detail: string }

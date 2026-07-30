/** Every failure mode the harness registry + launcher can produce. */
export type HarnessError =
  | { readonly kind: "invalid-template"; readonly token: string }
  | { readonly kind: "invalid-command"; readonly detail: string }
  | { readonly kind: "duplicate-id"; readonly id: string }
  | { readonly kind: "invalid-definition"; readonly detail: string }
  | { readonly kind: "read-failed"; readonly detail: string }
  | { readonly kind: "write-failed"; readonly detail: string }
  | { readonly kind: "spawn-failed"; readonly detail: string }
  | { readonly kind: "no-acp-config"; readonly id: string }

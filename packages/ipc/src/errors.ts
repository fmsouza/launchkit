/** Typed, message-safe IPC failures (no stack traces, no secrets). */
export type IpcError =
  | { readonly kind: "validation-failed"; readonly detail: string }
  | { readonly kind: "transport-failed"; readonly detail: string }
  | { readonly kind: "handler-failed"; readonly detail: string }

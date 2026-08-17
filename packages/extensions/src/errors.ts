/**
 * The complete extension/plugin error union. Declared complete here even though this task
 * only produces a subset — later plans (install, uninstall, source-tracking) use the rest,
 * and this union must not grow across plans.
 */
export type PluginError =
  | { readonly kind: "invalid-manifest"; readonly detail: string }
  | { readonly kind: "unsupported-api-version"; readonly apiVersion: string }
  | { readonly kind: "duplicate-id"; readonly id: string }
  | { readonly kind: "read-failed"; readonly detail: string }
  | { readonly kind: "write-failed"; readonly detail: string }
  | { readonly kind: "not-found"; readonly id: string }
  | {
      readonly kind: "in-use"
      readonly id: string
      readonly providerIds: readonly string[]
    }
  | { readonly kind: "git-failed"; readonly detail: string }
  | {
      readonly kind: "source-unavailable"
      readonly id: string
      readonly path: string
    }

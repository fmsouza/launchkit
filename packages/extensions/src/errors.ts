/**
 * The complete extension/plugin error union. Declared complete here even though this task
 * only produces a subset — later plans (install, uninstall, source-tracking) use the rest,
 * and this union must not grow across plans.
 */
export type PluginError =
  | {
      readonly kind: "invalid-manifest"
      readonly detail: string
      /**
       * The extension directory this manifest was read from, when the caller returning the
       * error knows it (`parseManifest` itself is pure and doesn't — it never sees a
       * directory — but `ExtensionRegistry.list()` does, and attaches it). Optional rather
       * than a new variant: Global Constraint 2 forbids adding a UNION MEMBER, not a field
       * on an existing one. Without this, `list()` failing the whole batch on one bad
       * manifest gives the caller no way to say WHICH extension is broken.
       */
      readonly id?: string
    }
  | {
      readonly kind: "unsupported-api-version"
      readonly apiVersion: string
      /** Same attribution as `invalid-manifest.id` above, for the same reason. */
      readonly id?: string
    }
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

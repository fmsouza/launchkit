import { type Result, err, ok } from "@spectrum/utils"
import type { PluginError } from "./errors"

/** One extension's still-unvalidated manifest bytes, tagged with the id its directory used. */
export type ExtensionEntry = { readonly id: string; readonly raw: unknown }

/**
 * Reads + JSON-parses each extension's `spectrum-extension.json`, and reads/removes a
 * single extension by id. Reads return the raw parsed manifest (still `unknown`);
 * validation happens in the registry.
 *
 * `listExtensions` returns entries for the extensions it could read, plus a per-id
 * `source-unavailable` failure for any linked extension whose source directory is gone —
 * one bad link does not fail the whole list. A read/parse failure that isn't a missing
 * manifest or a missing linked source is a batch-level failure (matches
 * `createDirHarnessFileSource`'s `read-failed` behavior).
 */
export interface ExtensionFileSource {
  listExtensions(): Promise<
    Result<
      readonly (
        | ExtensionEntry
        | { readonly id: string; readonly error: PluginError }
      )[],
      PluginError
    >
  >
  readExtension(id: string): Promise<Result<ExtensionEntry, PluginError>>
  removeExtension(id: string): Promise<Result<void, PluginError>>
  /** The directory an extension's files live in. Pure and synchronous — no IO, no existence check. */
  extensionDir(id: string): string
}

/**
 * In-memory fake: holds a mutable list of `{id, raw}` entries. `removeExtension` filters
 * by id. A preset `failure` short-circuits every method that would otherwise touch `store`.
 */
export const createInMemoryExtensionFileSource = (
  entries: readonly ExtensionEntry[],
  failure?: PluginError,
): ExtensionFileSource => {
  const store: ExtensionEntry[] = [...entries]
  return {
    listExtensions: async (): Promise<
      Result<readonly ExtensionEntry[], PluginError>
    > => (failure === undefined ? ok([...store]) : err(failure)),

    readExtension: async (
      id: string,
    ): Promise<Result<ExtensionEntry, PluginError>> => {
      if (failure !== undefined) return err(failure)
      const found = store.find((e) => e.id === id)
      return found === undefined ? err({ kind: "not-found", id }) : ok(found)
    },

    removeExtension: async (id: string): Promise<Result<void, PluginError>> => {
      if (failure !== undefined) return err(failure)
      const next = store.filter((e) => e.id !== id)
      store.length = 0
      store.push(...next)
      return ok(undefined)
    },

    // No real directory backs an in-memory entry; the path is purely informational.
    extensionDir: (id: string): string => `/in-memory/${id}`,
  }
}

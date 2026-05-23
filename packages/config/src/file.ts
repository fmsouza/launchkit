import { type Result, ok, err } from "@launchkit/utils"
import type { ConfigError } from "./errors"

/**
 * The config-file effect — the only thing a `ConfigStore` knows about the filesystem.
 *
 * The real adapter (`createFsConfigFile`, see config-04 integration test) MUST write atomically
 * and with restrictive permissions:
 *   1. write the full contents to a sibling `<file>.tmp`;
 *   2. `fsync` that temp file so the bytes hit disk;
 *   3. `rename` it over `<file>` (an atomic replace — a reader sees either the old or new file,
 *      never a half-written one);
 *   4. `chmod` the file to `0600` (owner read/write only) so secrets-adjacent config is private.
 * The containing directory (`~/.config/launchkit/`) is created `0700` if absent.
 */
export interface ConfigFile {
  read(): Promise<Result<string, ConfigError>>
  writeAtomic(contents: string): Promise<Result<void, ConfigError>>
  exists(): Promise<boolean>
}

/** A `ConfigFile` for unit tests. Records every `writeAtomic` so tests can assert exact content. */
export interface InMemoryConfigFile extends ConfigFile {
  /** Every value passed to `writeAtomic`, in order. */
  readonly writes: readonly string[]
}

/**
 * In-memory fake: no disk, fast, deterministic. `writeAtomic` appends to `writes` and replaces the
 * stored value in one step — mirroring the real adapter's atomic rename, so a reader never observes
 * a partial document.
 */
export const createInMemoryConfigFile = (initial?: string): InMemoryConfigFile => {
  const writes: string[] = []
  let contents: string | undefined = initial
  return {
    get writes(): readonly string[] {
      return writes
    },
    read: async (): Promise<Result<string, ConfigError>> =>
      contents === undefined ? err({ kind: "not-found" }) : ok(contents),
    writeAtomic: async (next: string): Promise<Result<void, ConfigError>> => {
      writes.push(next)
      contents = next
      return ok(undefined)
    },
    exists: async (): Promise<boolean> => contents !== undefined,
  }
}

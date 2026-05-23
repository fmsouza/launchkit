import { type Result, isOk } from "@launchkit/utils"
import type { Config } from "./schema"
import type { ConfigError } from "./errors"
import type { ConfigStore } from "./store"

/**
 * Wraps a `ConfigStore` with an in-memory cache (performance.md: disk is read once, then the
 * cache is the read path). The cache is a closure-local mutable cell — created per-factory-call,
 * never a module global. A failed `load` is NOT cached (so the next call retries); a failed
 * inner `save` leaves the cache untouched.
 */
export const createCachedConfigStore = (inner: ConfigStore): ConfigStore => {
  let cache: Config | undefined
  return {
    load: async (): Promise<Result<Config, ConfigError>> => {
      if (cache !== undefined) return { ok: true, value: cache }
      const loaded = await inner.load()
      if (isOk(loaded)) cache = loaded.value
      return loaded
    },
    save: async (config: Config): Promise<Result<void, ConfigError>> => {
      const written = await inner.save(config)
      if (isOk(written)) cache = config
      return written
    },
  }
}

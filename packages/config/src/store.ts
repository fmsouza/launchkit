import { type Result, ok, err, isOk } from "@launchkit/utils"
import { type Config, ConfigSchema, defaultConfig } from "./schema"
import { runMigrations } from "./migrations"
import type { ConfigError } from "./errors"
import type { ConfigFile } from "./file"

/** Read/write the whole config document. The read path returns a fully migrated + validated `Config`. */
export interface ConfigStore {
  load(): Promise<Result<Config, ConfigError>>
  save(config: Config): Promise<Result<void, ConfigError>>
}

const parseJson = (raw: string): Result<unknown, ConfigError> => {
  try {
    return ok(JSON.parse(raw) as unknown)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return err({ kind: "parse-failed", detail })
  }
}

export const createFileConfigStore = (deps: { readonly file: ConfigFile }): ConfigStore => {
  const { file } = deps
  return {
    load: async (): Promise<Result<Config, ConfigError>> => {
      if (!(await file.exists())) return ok(defaultConfig())

      const read = await file.read()
      if (!isOk(read)) return read

      const parsed = parseJson(read.value)
      if (!isOk(parsed)) return parsed

      return runMigrations(parsed.value)
    },
    // `save` is implemented in config-05.
    save: async (config: Config): Promise<Result<void, ConfigError>> => {
      const validated = ConfigSchema.safeParse(config)
      if (!validated.success) {
        return err({ kind: "write-failed", detail: validated.error.message })
      }
      return file.writeAtomic(JSON.stringify(validated.data, null, 2))
    },
  }
}

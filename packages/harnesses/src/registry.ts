import { type Result, ok, err, isErr } from "@launchkit/utils"
import { type HarnessDefinition, HarnessDefinitionSchema } from "@launchkit/types"
import type { HarnessError } from "./errors"
import type { HarnessFileSource } from "./file-source"
import { builtinHarnesses } from "./builtin/index"
import { validateEnvTemplate } from "./validate-env-template"

export interface HarnessRegistry {
  list(): Promise<Result<readonly HarnessDefinition[], HarnessError>>
}

export const createRegistry = (deps: { readonly fileSource: HarnessFileSource }): HarnessRegistry => ({
  list: async (): Promise<Result<readonly HarnessDefinition[], HarnessError>> => {
    const read = await deps.fileSource.listDefinitions()
    if (isErr(read)) return read

    const builtInIds = new Set(builtinHarnesses.map((h) => h.id))
    const userDefs: HarnessDefinition[] = []

    for (const raw of read.value) {
      // Force builtIn:false so a user file can never masquerade as a built-in.
      const candidate =
        typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>), builtIn: false } : raw

      const parsed = HarnessDefinitionSchema.safeParse(candidate)
      if (!parsed.success) {
        return err({ kind: "invalid-definition", detail: parsed.error.message })
      }
      const def = parsed.data

      if (builtInIds.has(def.id)) {
        return err({ kind: "duplicate-id", id: def.id })
      }

      const env = validateEnvTemplate(def.envTemplate)
      if (isErr(env)) return env

      userDefs.push(def)
    }

    return ok([...builtinHarnesses, ...userDefs])
  },
})

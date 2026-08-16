import { type ZodTypeAny, z } from "zod"
import type { ConfigFieldSpec } from "./types"

/** A headers field carries a JSON object whose every value is a string. */
const headersSchema = (): ZodTypeAny =>
  z.string().refine(
    (v) => {
      if (v === "") return true
      try {
        const parsed: unknown = JSON.parse(v)
        if (typeof parsed !== "object" || parsed === null) return false
        return Object.values(parsed).every((x) => typeof x === "string")
      } catch {
        return false
      }
    },
    { message: "headers must be a JSON object of string values" },
  )

const baseFor = (kind: ConfigFieldSpec["kind"]): ZodTypeAny => {
  if (kind === "url") return z.string().url()
  if (kind === "headers") return headersSchema()
  return z.string().min(1)
}

/**
 * Derive a strict zod object schema from a provider's declarative config field specs.
 *
 * A JSON plugin manifest cannot carry a zod schema, so a plugin descriptor's `configSchema`
 * is derived from the same `ConfigFieldSpec[]` the GUI renders its form from. The builtin
 * `custom` descriptor uses this too, so there is exactly one derivation in the codebase.
 */
export const configSchemaFromFields = (
  fields: readonly ConfigFieldSpec[],
): ZodTypeAny =>
  z
    .object(
      Object.fromEntries(
        fields.map((f) => [
          f.name,
          f.required ? baseFor(f.kind) : baseFor(f.kind).optional(),
        ]),
      ),
    )
    .strict()

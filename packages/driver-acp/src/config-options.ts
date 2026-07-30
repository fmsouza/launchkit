import type { ThinkingEffort } from "@spectrum/agent-events"
import type { AcpConfigOption } from "./acp-client"

/** A resolved config change: which option to set, and to which value. */
export interface AcpConfigChoice {
  readonly configId: string
  readonly valueId: string
}

const normalize = (s: string): string =>
  s.toLowerCase().replaceAll("-", "").replaceAll("_", "").replaceAll(" ", "")

/**
 * Find an option by the agent's own `category` first — the reliable signal, since display names
 * and ids vary per agent — falling back to matching the option id against known spellings for
 * agents that omit the category.
 */
const findOption = (
  options: readonly AcpConfigOption[],
  category: string,
  idCandidates: readonly string[],
): AcpConfigOption | undefined => {
  const byCategory = options.find((o) => o.category === category)
  if (byCategory !== undefined) return byCategory
  return options.find((o) => idCandidates.includes(normalize(o.id)))
}

/** Match a value by id first, then by display name — both case- and separator-insensitive. */
const findValueId = (
  option: AcpConfigOption,
  wanted: string,
): string | undefined => {
  const target = normalize(wanted)
  const byId = option.values.find((v) => normalize(v.id) === target)
  if (byId !== undefined) return byId.id
  return option.values.find((v) => normalize(v.name) === target)?.id
}

/** The agent's model option + the value for this model id, when it can honor it. Pure. */
export const pickModelOption = (
  options: readonly AcpConfigOption[],
  modelId: string,
): AcpConfigChoice | undefined => {
  const option = findOption(options, "model", ["model"])
  if (option === undefined) return undefined
  const valueId = findValueId(option, modelId)
  return valueId === undefined ? undefined : { configId: option.id, valueId }
}

/** The agent's reasoning-effort option + the value for this tier, when it can honor it. Pure. */
export const pickEffortOption = (
  options: readonly AcpConfigOption[],
  effort: ThinkingEffort,
): AcpConfigChoice | undefined => {
  const option =
    findOption(options, "thought_level", [
      "reasoningeffort",
      "effort",
      "thinking",
      "thoughtlevel",
    ]) ?? findOption(options, "model_config", [])
  if (option === undefined) return undefined
  const valueId = findValueId(option, effort)
  return valueId === undefined ? undefined : { configId: option.id, valueId }
}

/**
 * The agent's session-mode option, when it advertises modes as a CONFIG OPTION rather than via
 * `session/new`'s `modes` field. OpenCode does exactly this (`category: "mode"`, values
 * build/plan) — verified against a live `opencode acp` process — so a client that only reads
 * `modes` sees no modes at all. Pure.
 */
export const pickModeOption = (
  options: readonly AcpConfigOption[],
): AcpConfigOption | undefined => findOption(options, "mode", ["mode"])

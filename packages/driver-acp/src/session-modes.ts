import type { PermissionMode } from "@spectrum/agent-events"

/**
 * ACP mode ids are AGENT-DEFINED strings — `session/new` returns them in `modes.availableModes`,
 * and every agent spells them differently (Claude: `default`/`acceptEdits`/`plan`/
 * `bypassPermissions`; others: `manual`, `auto`, `yolo`, ...). So the Spectrum↔ACP mapping is a
 * best-match against known spellings rather than a fixed table. Candidates are ordered
 * most-specific-first; comparison ignores case and `-`/`_` separators.
 */
const CANDIDATES: Readonly<Record<PermissionMode, readonly string[]>> = {
  manual: ["default", "manual", "normal", "ask", "untrusted"],
  "auto-edits": ["acceptedits", "autoedits", "onfailure", "auto"],
  plan: ["plan", "planning", "readonly"],
  bypass: ["bypasspermissions", "bypass", "yolo", "fullaccess", "never"],
}

const ALL_MODES: readonly PermissionMode[] = [
  "manual",
  "auto-edits",
  "plan",
  "bypass",
]

const normalize = (id: string): string =>
  id.toLowerCase().replaceAll("-", "").replaceAll("_", "")

/** The agent's mode id for a Spectrum mode, or undefined when the agent can't honor it. Pure. */
export const pickAcpModeId = (
  mode: PermissionMode,
  availableModeIds: readonly string[],
): string | undefined => {
  for (const candidate of CANDIDATES[mode]) {
    const hit = availableModeIds.find((id) => normalize(id) === candidate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * The Spectrum modes this agent can actually honor — what the UI's mode selector should offer.
 * Emitted on `runner-started.supportedModes`. Pure.
 */
export const supportedModesFrom = (
  availableModeIds: readonly string[],
): readonly PermissionMode[] =>
  ALL_MODES.filter((m) => pickAcpModeId(m, availableModeIds) !== undefined)

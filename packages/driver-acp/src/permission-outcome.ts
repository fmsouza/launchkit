import type { ApprovalDecision } from "@spectrum/agent-events"
import type { AcpPermissionOption } from "./acp-client"

/**
 * ACP's `session/request_permission` offers agent-defined OPTIONS, each tagged with a kind; the
 * client answers with one option's id. Spectrum's approval card produces a decision instead, so the
 * decision picks the first advertised kind in preference order. A same-polarity fallback keeps a
 * user's "always" answer working against an agent that only offers a one-shot option.
 */
const PREFERENCE: Readonly<
  Record<ApprovalDecision, readonly AcpPermissionOption["kind"][]>
> = {
  allow: ["allow_once", "allow_always"],
  "allow-always": ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
}

/** The optionId to answer a permission request with, or undefined when none fits. Pure. */
export const pickPermissionOptionId = (
  decision: ApprovalDecision,
  options: readonly AcpPermissionOption[],
): string | undefined => {
  for (const kind of PREFERENCE[decision]) {
    const hit = options.find((o) => o.kind === kind)
    if (hit !== undefined) return hit.optionId
  }
  return undefined
}

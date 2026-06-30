import type { RunnerId, RunnerState } from "@spectrum/agent-events"
import { subAgentDetail } from "./subAgentDetail"

/**
 * The human hint shown beside "Agent" on a sub-runner row, shared by the rail
 * roster and the chat timeline: the child runner's own title if it has one,
 * else the "started-for" description pulled from the parent runner's spawning
 * tool-call. PURE — given a runner id and the session's runners, returns a
 * string (or undefined). No IO.
 *
 * Reproduces the chat's previous inline logic
 * `childRunner?.title ?? subAgentDetail(item.input)`, where `item` is the
 * parent's tool-call whose spawnedRunnerId === runnerId.
 */
export const subRunnerDetail = (
  runnerId: RunnerId,
  runners: ReadonlyMap<RunnerId, RunnerState>,
): string | undefined => {
  const runner = runners.get(runnerId)
  if (runner === undefined) return undefined
  if (runner.title !== undefined) return runner.title
  const parentId = runner.parentRunnerId
  if (parentId === undefined) return undefined
  const parent = runners.get(parentId)
  if (parent === undefined) return undefined
  const spawnCall = parent.items.find(
    (i): i is Extract<typeof i, { kind: "tool-call" }> =>
      i.kind === "tool-call" && i.spawnedRunnerId === runnerId,
  )
  return spawnCall === undefined ? undefined : subAgentDetail(spawnCall.input)
}

import type { RunnerId, RunnerState } from "@spectrum/agent-events"
import type { ReactElement } from "react"
import { SubRunnerCard } from "../molecules/SubRunnerCard"
import { subRunnerDetail } from "../molecules/subRunnerDetail"

export type SubRunnerListProps = {
  /** All runners for the session (includes the root). */
  readonly runners: ReadonlyMap<RunnerId, RunnerState>
  /** The root runner id to exclude. If omitted, the runner whose parentRunnerId is undefined is treated as root. */
  readonly rootRunnerId?: RunnerId
  /** The currently focused sub-runner, for the selected-row affordance. */
  readonly openRunnerId?: RunnerId
  /** Focus a runner: the caller swaps the rail to its timeline. */
  readonly onOpen: (id: RunnerId) => void
}

/** Resolve the root runner id: explicit prop, else the runner with no parent. */
const resolveRootId = (
  runners: ReadonlyMap<RunnerId, RunnerState>,
  rootRunnerId?: RunnerId,
): RunnerId | undefined => {
  if (rootRunnerId !== undefined) return rootRunnerId
  for (const r of runners.values())
    if (r.parentRunnerId === undefined) return r.id
  return undefined
}

/** Sub-runners in display order: running first, then the rest, each in spawn (Map insertion) order. */
const orderedSubs = (
  runners: ReadonlyMap<RunnerId, RunnerState>,
  rootId: RunnerId | undefined,
): readonly RunnerState[] => {
  const subs = Array.from(runners.values()).filter((r) => r.id !== rootId)
  const running = subs.filter((r) => r.status === "running")
  const rest = subs.filter((r) => r.status !== "running")
  return [...running, ...rest]
}

export const SubRunnerList = ({
  runners,
  rootRunnerId,
  openRunnerId,
  onOpen,
}: SubRunnerListProps): ReactElement => {
  const rootId = resolveRootId(runners, rootRunnerId)
  const subs = orderedSubs(runners, rootId)
  if (subs.length === 0)
    return (
      <div className="lk-sub-runner-list">
        <p className="lk-sub-runner-list__empty">No sub-agents yet</p>
      </div>
    )
  return (
    <ul className="lk-sub-runner-list" aria-label="Sub-agents">
      {subs.map((r) => (
        <li
          key={String(r.id)}
          {...(openRunnerId === r.id
            ? { "aria-current": "true" as const }
            : {})}
        >
          <SubRunnerCard
            runnerId={r.id}
            title="Agent"
            {...(() => {
              const detail = subRunnerDetail(r.id, runners)
              return detail === undefined ? {} : { detail }
            })()}
            status={r.status}
            onOpen={onOpen}
          />
        </li>
      ))}
    </ul>
  )
}

import type { RunnerId, RunnerState, TaskList } from "@spectrum/agent-events"
import { type ReactElement, useState } from "react"
import { IconButton } from "../atoms/IconButton"
import { Tooltip } from "../atoms/Tooltip"
import { SubRunnerList } from "./SubRunnerList"
import { SubRunnerPane } from "./SubRunnerPane"
import { TaskRail } from "./TaskRail"

export type RunSideRailProps = {
  /** Root runner's task list (when shown alone, no sub open). Undefined or empty = no list. */
  readonly rootTaskList?: TaskList
  /** The open sub-runner, when one is focused. */
  readonly subRunner?: RunnerState
  /** The focused sub-runner's own task list. Undefined = the sub has no tasks. */
  readonly subTaskList?: TaskList
  readonly runners: ReadonlyMap<RunnerId, RunnerState>
  readonly subBreadcrumb: readonly string[]
  readonly onOpenSubRunner: (id: RunnerId) => void
  readonly onCloseSub: () => void
  /** When true the column is reduced to a thin strip with an expand control. Default false. */
  readonly collapsed?: boolean
  /** Toggle the collapsed state. Required for the collapse/expand controls to do anything. */
  readonly onToggleCollapsed?: () => void
  /** Open a chat link in the OS browser; threaded to the sub-runner pane's timeline. */
  readonly onOpenLink?: (url: string) => void
  /** Whether the terminal pane is currently open. Drives the footer's active state. */
  readonly paneOpen?: boolean
  /** Toggle the terminal pane (open if closed, close if open). */
  readonly onToggleTerminal?: () => void
}

/** Non-root runners — the session's sub-agents — in spawn order. */
const subRunnersOf = (
  runners: ReadonlyMap<RunnerId, RunnerState>,
): readonly RunnerState[] => {
  const subs: RunnerState[] = []
  let rootId: RunnerId | undefined
  for (const r of runners.values()) {
    if (r.parentRunnerId === undefined) {
      rootId = r.id
      continue
    }
    subs.push(r)
  }
  // Defense-in-depth: the loop above already excludes the root (it `continue`s
  // past runners with `parentRunnerId === undefined`), so `subs` cannot contain
  // the root for a well-formed `RunState`. This filter guards the pure-data
  // case — the rail may receive any `RunState` shape, including malformed
  // ones — and must NOT be removed.
  return subs.filter((r) => r.id !== rootId)
}

export const RunSideRail = ({
  rootTaskList,
  subRunner,
  subTaskList,
  runners,
  subBreadcrumb,
  onOpenSubRunner,
  onCloseSub,
  collapsed = false,
  onToggleCollapsed = () => {},
  onOpenLink,
  paneOpen = false,
  onToggleTerminal = () => {},
}: RunSideRailProps): ReactElement | null => {
  // Which segment is showing. Defaults to the sub-agent; the caller keys this component by the open
  // sub-runner id so a new sub re-mounts and resets here.
  const [segment, setSegment] = useState<"tasks" | "sub">("sub")

  // Availability: which segments have content to show. Same rule for the vertical
  // buttons (collapsed) and the tab buttons (expanded).
  const tasksAvailable =
    (subRunner !== undefined ? subTaskList : rootTaskList) !== undefined
  const subs = subRunnersOf(runners)
  const subAvailable = subs.length > 0
  // The terminal is always available inside a session: the backend resolves a
  // working directory via sessionCwd → projectPath → homeDir, so the toggle is
  // never gated on a UI-passed cwd.
  const terminalLabel = paneOpen ? "Hide terminal pane" : "Show terminal pane"

  // Collapsed: a thin vertical strip with an expand control and vertical
  // Tasks/Sub-agent buttons (disabled when their content is empty). Always
  // renders — even when both are empty — so the rail never disappears. The
  // tasks count lives only inside the expanded TaskRail panel.
  if (collapsed) {
    return (
      <aside className="lk-side-rail lk-side-rail--collapsed">
        <button
          type="button"
          className="lk-side-rail__expand"
          aria-label="Expand tasks panel"
          onClick={() => onToggleCollapsed()}
        >
          ‹
        </button>
        <button
          type="button"
          className="lk-side-rail__vtab"
          aria-label="Tasks"
          disabled={!tasksAvailable}
          onClick={() => {
            setSegment("tasks")
            onToggleCollapsed()
          }}
        >
          Tasks
        </button>
        <button
          type="button"
          className="lk-side-rail__vtab"
          aria-label="Sub-agent"
          disabled={!subAvailable}
          onClick={() => {
            setSegment("sub")
            onToggleCollapsed()
          }}
        >
          Sub-agent
        </button>
        <div className="lk-side-rail__footer">
          <Tooltip label={terminalLabel} placement="left">
            <IconButton
              label={terminalLabel}
              active={paneOpen}
              onClick={() => onToggleTerminal()}
            >
              ▤
            </IconButton>
          </Tooltip>
        </div>
      </aside>
    )
  }

  // Expanded: one fixed structure. The Tasks/Sub-agent header is always
  // present; each tab is disabled when its content is empty. The body is
  // always a real component. Sub-agent shows the roster when no sub is
  // focused, or the focused agent's timeline (with Back) when one is.
  const activeTaskList = subRunner !== undefined ? subTaskList : rootTaskList
  const showingTasks = segment === "tasks" && tasksAvailable
  const subRunnerId = subRunner?.id
  return (
    <aside className="lk-side-rail" data-sub-open={subRunner !== undefined}>
      <div className="lk-side-rail__seg" role="tablist" aria-label="Side panel">
        <button
          type="button"
          role="tab"
          className="lk-side-rail__tab"
          aria-selected={showingTasks}
          disabled={!tasksAvailable}
          onClick={() => setSegment("tasks")}
        >
          Tasks
        </button>
        <button
          type="button"
          role="tab"
          className="lk-side-rail__tab"
          aria-selected={!showingTasks}
          disabled={!subAvailable}
          onClick={() => setSegment("sub")}
        >
          Sub-agent
        </button>
        <button
          type="button"
          className="lk-side-rail__collapse"
          aria-label="Collapse tasks panel"
          onClick={() => onToggleCollapsed()}
        >
          ›
        </button>
      </div>
      {showingTasks && activeTaskList !== undefined ? (
        <TaskRail taskList={activeTaskList} onCollapse={onToggleCollapsed} />
      ) : subAvailable ? (
        subRunner !== undefined ? (
          <SubRunnerPane
            runner={subRunner}
            runners={runners}
            breadcrumb={subBreadcrumb}
            onOpenSubRunner={onOpenSubRunner}
            onClose={onCloseSub}
            {...(onOpenLink === undefined ? {} : { onOpenLink })}
          />
        ) : (
          <SubRunnerList
            runners={runners}
            {...(subRunnerId === undefined
              ? {}
              : { openRunnerId: subRunnerId })}
            onOpen={onOpenSubRunner}
          />
        )
      ) : activeTaskList !== undefined ? (
        // Root-only with tasks: show them even though the default segment is "sub",
        // because Sub-agent is unavailable.
        <TaskRail taskList={activeTaskList} onCollapse={onToggleCollapsed} />
      ) : null}
      <div className="lk-side-rail__footer">
        <Tooltip label={terminalLabel} placement="top">
          <IconButton
            label={terminalLabel}
            active={paneOpen}
            onClick={() => onToggleTerminal()}
          >
            ▤
          </IconButton>
        </Tooltip>
      </div>
    </aside>
  )
}

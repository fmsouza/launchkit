import type {
  ApprovalDecision,
  PermissionMode,
  QuestionAnswer,
  RunnerId,
  RunnerState,
  ThinkingEffort,
} from "@spectrum/agent-events"
import { selectTaskList } from "@spectrum/agent-events"
import type { ModelRoute } from "@spectrum/types"
import { type ReactElement, useEffect, useRef, useState } from "react"
import { TypingIndicator } from "../atoms/TypingIndicator"
import { Composer } from "../molecules/Composer"
import { ConversationTimeline } from "./ConversationTimeline"
import { RunSideRail } from "./RunSideRail"
import { TerminalPane } from "./TerminalPane"

/**
 * Minimum shape `RunView` consumes from a `useTerminal` controller
 * (dumb-presentational seam so this organism never imports the desktop store).
 *
 * `mountTerminal` returns a cleanup that fires when the tab swaps or the pane
 * unmounts — `TerminalPane` honors it so per-tab xterm instances are torn down
 * on tab change without a manual dispose call here.
 */
export interface TerminalController {
  readonly paneOpen: boolean
  readonly tabs: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly exitCode: number | null
    readonly closed: boolean
  }>
  readonly activeTabId: string | null
  readonly paneHeightPx: number
  openPane(): Promise<void>
  closePane(): void
  newTab(): Promise<void>
  closeTab(tabId: string): void
  resizeHeight(px: number): void
  selectTab(tabId: string): void
  mountTerminal(tabId: string, container: HTMLElement): () => void
}

export type RunViewProps = {
  readonly root: RunnerState
  readonly runners: ReadonlyMap<RunnerId, RunnerState>
  readonly openRunner?: RunnerState
  readonly subBreadcrumb: readonly string[]
  readonly onOpenSubRunner: (id: RunnerId) => void
  readonly onCloseSub: () => void
  readonly onSend: (text: string) => void
  readonly onDecide: (requestId: string, decision: ApprovalDecision) => void
  readonly onAnswer: (requestId: string, answer: QuestionAnswer) => void
  /** Optimistic / failed sends not yet reconciled (forwarded to the timeline). */
  readonly pending?: readonly {
    readonly clientSendId: string
    readonly text: string
    readonly status: "sending" | "failed"
  }[]
  /** Re-dispatch a prompt (failed pending send, or the last errored turn). Hidden while busy. */
  readonly onResend?: (entry: { clientSendId?: string; text: string }) => void
  /** Discard a failed send + restore its text to the composer. Hidden while busy. */
  readonly onCancel?: (entry: { clientSendId?: string; text: string }) => void
  /** Suppress the errored-message footer once dismissed via Cancel. */
  readonly dismissedErrorId?: string
  /** Text to drop into the composer (Cancel → restore). */
  readonly prefillText?: string
  /** Bump to re-apply `prefillText`. */
  readonly prefillKey?: string
  /** Show the typing indicator + keep the feed pinned to the bottom while a turn is in flight. */
  readonly busy?: boolean
  /** Seconds the in-flight turn has run; shown in the typing indicator. */
  readonly elapsedSeconds?: number
  readonly inert?: boolean
  /**
   * Whether the composer is disabled. Defaults to `inert` so the existing replay-mode
   * call site (which passes `inert` to disable approvals) keeps the composer disabled.
   * Pass `false` to keep the composer enabled while approvals stay inert (e.g. replay
   * mode where sending re-opens the session for auto-resume).
   */
  readonly composerDisabled?: boolean
  readonly onInterrupt?: () => void
  readonly mode?: PermissionMode
  readonly onModeChange?: (mode: PermissionMode) => void
  /** Current model id, or "" for the default (no-proxy) route. */
  readonly model?: string
  readonly models?: readonly ModelRoute[]
  readonly providerNames?: Readonly<Record<string, string>>
  readonly onModelChange?: (modelId: string) => void
  readonly effort?: ThinkingEffort
  readonly onEffortChange?: (effort: ThinkingEffort) => void
  /** Open a chat link in the OS browser; threaded to both timelines. */
  readonly onOpenLink?: (url: string) => void
  /** Optional terminal controller (threaded from `RunDetail`'s `useTerminal` call). */
  readonly terminal?: TerminalController
}

/** A length proxy for the feed's content so streaming text (not just new items) triggers autoscroll. */
const contentTick = (root: RunnerState): number => {
  const last = root.items.at(-1)
  const tail =
    last === undefined
      ? 0
      : "text" in last
        ? last.text.length
        : "output" in last && last.output !== undefined
          ? last.output.length
          : 0
  return root.items.length * 1_000_000 + tail
}

export const RunView = ({
  root,
  runners,
  openRunner,
  subBreadcrumb,
  onOpenSubRunner,
  onCloseSub,
  onSend,
  onDecide,
  onAnswer,
  pending,
  onResend,
  onCancel,
  dismissedErrorId,
  prefillText,
  prefillKey,
  busy = false,
  elapsedSeconds,
  inert = false,
  composerDisabled,
  onInterrupt,
  mode,
  onModeChange,
  model,
  models,
  providerNames,
  onModelChange,
  effort,
  onEffortChange,
  onOpenLink,
  terminal,
}: RunViewProps): ReactElement => {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Autoscroll: pin the feed to the latest message as items stream in (and when the dots appear).
  const tick = contentTick(root)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick`/`busy` are the content signal; the ref is stable.
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [tick, busy])

  // Collapsed state lives here, above RunSideRail's per-sub `key`, so it survives drilling in and out
  // of sub-runners (it resets only when this conversation view unmounts).
  const [railCollapsed, setRailCollapsed] = useState(true)

  // Auto-expand when a sub-runner becomes focused so pressing Open lands the
  // user on the Sub-agent tab (issue #2). Once expanded, the user's manual
  // collapse choice is respected until the next sub-open auto-expands again.
  useEffect(() => {
    if (openRunner !== undefined) setRailCollapsed(false)
  }, [openRunner])

  const rootList = selectTaskList(root)
  const rootTaskList =
    rootList !== undefined && rootList.total > 0 ? rootList : undefined
  const subList =
    openRunner === undefined ? undefined : selectTaskList(openRunner)
  const subTaskList =
    subList !== undefined && subList.total > 0 ? subList : undefined

  return (
    <div
      className="lk-run-view"
      data-sub-open={openRunner !== undefined || rootTaskList !== undefined}
    >
      <section className="lk-run-view__main">
        <div className="lk-run-view__scroll" ref={scrollRef}>
          {root.error !== undefined ? (
            <div className="lk-run-error" role="alert">
              <span className="lk-run-error__icon" aria-hidden>
                !
              </span>
              <div className="lk-run-error__body">
                <p className="lk-run-error__title">Runner errored</p>
                <p className="lk-run-error__detail">{root.error}</p>
              </div>
            </div>
          ) : null}
          <ConversationTimeline
            runner={root}
            runners={runners}
            onOpenSubRunner={onOpenSubRunner}
            onDecide={onDecide}
            onAnswer={onAnswer}
            {...(pending === undefined ? {} : { pending })}
            {...(onResend !== undefined && !busy ? { onResend } : {})}
            {...(onCancel !== undefined && !busy ? { onCancel } : {})}
            {...(dismissedErrorId === undefined ? {} : { dismissedErrorId })}
            {...(onOpenLink === undefined ? {} : { onOpenLink })}
            inert={inert}
          />
          {busy ? (
            <TypingIndicator
              {...(elapsedSeconds === undefined ? {} : { elapsedSeconds })}
            />
          ) : null}
        </div>
        <Composer
          onSend={onSend}
          disabled={composerDisabled ?? inert}
          busy={busy}
          {...(prefillText === undefined ? {} : { prefillText })}
          {...(prefillKey === undefined ? {} : { prefillKey })}
          {...(onInterrupt === undefined ? {} : { onInterrupt })}
          {...(root.supportedModes === undefined
            ? {}
            : { supportedModes: root.supportedModes })}
          {...(mode === undefined ? {} : { mode })}
          {...(onModeChange === undefined ? {} : { onModeChange })}
          {...(model === undefined ? {} : { model })}
          {...(models === undefined ? {} : { models })}
          {...(providerNames === undefined ? {} : { providerNames })}
          {...(onModelChange === undefined ? {} : { onModelChange })}
          {...(effort === undefined ? {} : { effort })}
          {...(onEffortChange === undefined ? {} : { onEffortChange })}
        />
        {terminal && (terminal.paneOpen || terminal.tabs.length > 0) ? (
          // Keep the pane MOUNTED whenever the pane is open OR has live tabs, and
          // collapse it via the `hidden` attribute. Unmounting on collapse would
          // tear down the xterm DOM and kill the running PTYs — so a closed pane
          // would lose every session. Hiding preserves them for reopen.
          <TerminalPane
            hidden={!terminal.paneOpen}
            tabs={terminal.tabs}
            activeTabId={terminal.activeTabId}
            paneHeightPx={terminal.paneHeightPx}
            onSelectTab={terminal.selectTab}
            onNewTab={() => {
              void terminal.newTab()
            }}
            onCloseTab={terminal.closeTab}
            onResizeHeight={terminal.resizeHeight}
            mountTerminal={terminal.mountTerminal}
          />
        ) : null}
      </section>
      <RunSideRail
        key={openRunner?.id ?? "root"}
        {...(rootTaskList === undefined ? {} : { rootTaskList })}
        {...(openRunner === undefined ? {} : { subRunner: openRunner })}
        {...(subTaskList === undefined ? {} : { subTaskList })}
        runners={runners}
        subBreadcrumb={subBreadcrumb}
        onOpenSubRunner={onOpenSubRunner}
        onCloseSub={onCloseSub}
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((c) => !c)}
        {...(onOpenLink === undefined ? {} : { onOpenLink })}
        {...(terminal === undefined ? {} : { paneOpen: terminal.paneOpen })}
        onToggleTerminal={() => {
          if (terminal === undefined) return
          if (terminal.paneOpen) terminal.closePane()
          else void terminal.openPane()
        }}
      />
    </div>
  )
}

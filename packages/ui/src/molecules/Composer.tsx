import type {
  AttachmentCapabilities,
  AttachmentRef,
  PermissionMode,
  ThinkingEffort,
} from "@spectrum/agent-events"
import type { ModelRoute } from "@spectrum/types"
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react"
import { Icon } from "../atoms/Icon"
import { AttachmentTray } from "./AttachmentTray"
import { ModeSelector } from "./ModeSelector"
import { ModelSelector } from "./ModelSelector"
import { ThinkingEffortSelector } from "./ThinkingEffortSelector"

/**
 * Measure a textarea's content height and clamp it to a cap.
 *
 * Resets `el.style.height` to "auto" first so `scrollHeight` reflects the
 * content's natural height rather than the currently-fixed height, then
 * returns `min(scrollHeight, maxHeight)`. The caller assigns the returned
 * value to `el.style.height`. Pure w.r.t. the passed node — no globals.
 */
export const growTextareaHeight = (
  el: HTMLTextAreaElement,
  maxHeight: number,
): number => {
  el.style.height = "auto"
  return Math.min(el.scrollHeight, maxHeight)
}

/**
 * Resolve the textarea's growth cap in px from the CSS `max-height`
 * (the source of truth, so the `33dvh` number lives in CSS only).
 *
 * Falls back to `innerHeight / 3` when the computed max-height is not a
 * usable pixel value (e.g. it was not set, or resolved to a non-px form).
 */
export const resolveMaxHeightPx = (el: HTMLTextAreaElement): number => {
  const computed = window.getComputedStyle(el).maxHeight
  const px = Number.parseFloat(computed)
  if (Number.isFinite(px) && px > 0) return px
  return Math.floor(window.innerHeight / 3)
}

export type ComposerTurn = {
  readonly text: string
  readonly attachments?: readonly AttachmentRef[]
}

export type ComposerProps = {
  readonly onSend: (turn: ComposerTurn) => void
  readonly disabled?: boolean
  /** A turn is in flight: swap send → stop (the cancel affordance). Typing stays enabled. */
  readonly busy?: boolean
  readonly onInterrupt?: () => void
  readonly mode?: PermissionMode
  readonly supportedModes?: readonly PermissionMode[]
  readonly onModeChange?: (mode: PermissionMode) => void
  /** Current model id, or "" for the default (no-proxy) route. */
  readonly model?: string
  readonly models?: readonly ModelRoute[]
  readonly providerNames?: Readonly<Record<string, string>>
  readonly onModelChange?: (modelId: string) => void
  readonly effort?: ThinkingEffort
  readonly onEffortChange?: (effort: ThinkingEffort) => void
  /** Text to drop into the input (e.g. a cancelled failed send restored for editing). */
  readonly prefillText?: string
  /** Bump to re-apply `prefillText` even when the text is unchanged. */
  readonly prefillKey?: string
  /** What kinds of attachments the active model accepts. Drives the attach button visibility. */
  readonly attachmentCapabilities?: AttachmentCapabilities
  /** Files the user has staged for the next send. */
  readonly pendingAttachments?: readonly AttachmentRef[]
  /** Optional pre-rendered thumbnails keyed by `AttachmentRef.id`. */
  readonly attachmentThumbnails?: ReadonlyMap<string, string>
  /** Triggered when the user clicks the paperclip (opens the native picker). */
  readonly onPickAttachments?: () => void
  /** Remove a staged attachment (e.g. clicks the chip's X). */
  readonly onRemoveAttachment?: (id: string) => void
  /** Open a staged attachment (e.g. clicks the chip body). */
  readonly onOpenAttachment?: (ref: AttachmentRef) => void
  /**
   * Files dropped onto the composer card (the page stages them exactly like
   * picked files). Providing it — together with attachment support and not
   * being disabled — is what arms the drop-target behavior.
   */
  readonly onDropFiles?: (files: readonly File[]) => void
}

export const Composer = ({
  onSend,
  disabled = false,
  busy = false,
  onInterrupt,
  mode,
  supportedModes,
  onModeChange,
  model = "",
  models,
  providerNames,
  onModelChange,
  effort,
  onEffortChange,
  prefillText,
  prefillKey,
  attachmentCapabilities,
  pendingAttachments,
  attachmentThumbnails,
  onPickAttachments,
  onRemoveAttachment,
  onOpenAttachment,
  onDropFiles,
}: ComposerProps): ReactElement => {
  const [text, setText] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Apply an external prefill (Cancel → restore text to composer). Keyed so repeated cancels of the
  // same text re-apply. Intentionally omits `prefillText` from deps so only a key bump triggers it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: prefillKey is the apply signal.
  useEffect(() => {
    if (prefillText !== undefined) setText(prefillText)
  }, [prefillKey])

  const grow = (el: HTMLTextAreaElement): void => {
    const height = growTextareaHeight(el, resolveMaxHeightPx(el))
    el.style.height = `${height}px`
  }

  // Re-measure whenever text changes, so external mutations (notably the
  // clear-after-send) collapse the field back to its min-height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `grow` only closes over the stable `inputRef` and pure helpers.
  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    if (text === "") {
      el.style.height = "auto"
      return
    }
    grow(el)
  }, [text])
  const attachmentsSupported =
    attachmentCapabilities !== undefined &&
    (attachmentCapabilities.image ||
      attachmentCapabilities.pdf ||
      attachmentCapabilities.binary)
  const hasPending = (pendingAttachments ?? []).length > 0

  // Drag-and-drop: the whole card is a drop target while the model accepts
  // attachments. Depth-counted because dragenter/dragleave also fire on every
  // child the pointer crosses (a plain boolean would flicker).
  const [dragDepth, setDragDepth] = useState(0)
  const canAcceptDrop =
    attachmentsSupported && !disabled && onDropFiles !== undefined
  const isFileDrag = (e: DragEvent<HTMLDivElement>): boolean =>
    e.dataTransfer.types.includes("Files")
  const onDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    if (!canAcceptDrop || !isFileDrag(e)) return
    e.preventDefault()
    setDragDepth((d) => d + 1)
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!canAcceptDrop || !isFileDrag(e)) return
    e.preventDefault() // required — without it the browser refuses the drop
    e.stopPropagation() // keep the window-level guard from forcing dropEffect "none"
    e.dataTransfer.dropEffect = "copy"
  }
  const onDragLeave = (): void => {
    // Unconditional (clamped) decrement: non-file drags never increment, and
    // some engines omit dataTransfer.types on leave — symmetry via clamping.
    if (!canAcceptDrop) return
    setDragDepth((d) => Math.max(0, d - 1))
  }
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!canAcceptDrop) return
    setDragDepth(0)
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) onDropFiles?.(files)
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed === "" && !hasPending) return
    onSend({
      text: trimmed,
      ...(hasPending ? { attachments: [...(pendingAttachments ?? [])] } : {}),
    })
    setText("")
  }
  // Enter sends; Shift+Enter inserts a newline (the textarea's default, so don't preventDefault there).
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div
      className={`lk-composer${dragDepth > 0 ? " lk-composer--drop-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {hasPending ? (
        <AttachmentTray
          attachments={pendingAttachments ?? []}
          {...(attachmentThumbnails !== undefined
            ? { thumbnails: attachmentThumbnails }
            : {})}
          {...(onRemoveAttachment !== undefined
            ? { onRemove: onRemoveAttachment }
            : {})}
          {...(onOpenAttachment !== undefined
            ? { onOpen: onOpenAttachment }
            : {})}
        />
      ) : null}
      <textarea
        ref={inputRef}
        className="lk-composer__input"
        value={text}
        disabled={disabled}
        placeholder="Send a message  (Enter to send · Shift+Enter for newline)"
        onChange={(e) => setText(e.target.value)}
        onInput={(e) => grow(e.currentTarget)}
        onKeyDown={onKeyDown}
      />
      <div className="lk-composer__bar">
        {supportedModes === undefined || onModeChange === undefined ? null : (
          <ModeSelector
            mode={mode ?? "manual"}
            supportedModes={supportedModes}
            onChange={onModeChange}
            disabled={disabled}
          />
        )}
        {models === undefined || onModelChange === undefined ? null : (
          <ModelSelector
            model={model}
            models={models}
            {...(providerNames === undefined ? {} : { providerNames })}
            onChange={onModelChange}
            disabled={disabled}
          />
        )}
        {effort === undefined || onEffortChange === undefined ? null : (
          <ThinkingEffortSelector
            effort={effort}
            onChange={onEffortChange}
            disabled={disabled}
          />
        )}
        <div className="lk-composer__actions">
          {attachmentsSupported ? (
            <button
              type="button"
              className="lk-composer__action"
              data-action="attach"
              aria-label="Attach files"
              disabled={disabled}
              onClick={() => onPickAttachments?.()}
            >
              <Icon name="paperclip" size={14} />
            </button>
          ) : null}
          {busy ? (
            <button
              type="button"
              className="lk-composer__action"
              data-action="stop"
              aria-label="Stop run"
              onClick={() => onInterrupt?.()}
            >
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="lk-composer__action"
              data-action="send"
              aria-label="Send message"
              disabled={disabled || (text.trim() === "" && !hasPending)}
              onClick={() => submit()}
            >
              <Icon name="send" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

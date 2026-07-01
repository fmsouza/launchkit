/**
 * Neutralize file drops outside designated drop targets: without this, a
 * stray drop can navigate the webview to the dropped file. `dragover` must
 * be preventDefault'd at the window for `drop` to fire anywhere at all;
 * `dropEffect = "none"` keeps the cursor honest outside real targets (the
 * composer stopPropagation()s its own dragover, so file drags over it never
 * reach this guard). Returns an uninstaller for symmetry and tests —
 * production installs once at mount and never tears down.
 */
export const installGlobalDropGuard = (
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): (() => void) => {
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault()
    // Widened: a synthetic `Event` (tests) has no dataTransfer at all, so the
    // runtime value can be undefined even though the DOM type says `| null`.
    const dt: DataTransfer | null | undefined = e.dataTransfer
    if (dt !== null && dt !== undefined) dt.dropEffect = "none"
  }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
  }
  target.addEventListener("dragover", onDragOver)
  target.addEventListener("drop", onDrop)
  return () => {
    target.removeEventListener("dragover", onDragOver)
    target.removeEventListener("drop", onDrop)
  }
}

import { isSafeExternalUrl } from "@spectrum/extensions"
import type { PluginError } from "@spectrum/extensions"
import { type Result, err, ok } from "@spectrum/utils"

export type OpenExternal = (url: string) => Promise<Result<void, PluginError>>

/**
 * Hand a URL to the OS browser through an injected capability (in the desktop app,
 * Electrobun's `Utils.openExternal` via `GuiContext.openExternalUrl`).
 *
 * The scheme is validated FIRST: only http(s) may reach the opener, or Spectrum becomes a
 * launcher for arbitrary registered URL handlers on an extension's behalf. The capability is
 * an FFI call, so a throw is converted to a `Result` — an unhandled rejection here would take
 * the main process down on a malformed url.
 */
export const createGuardedOpenExternal =
  (open: (url: string) => Promise<boolean>): OpenExternal =>
  async (url: string): Promise<Result<void, PluginError>> => {
    if (!isSafeExternalUrl(url))
      return err({ kind: "write-failed", detail: "unsupported url scheme" })
    try {
      return (await open(url))
        ? ok(undefined)
        : err({
            kind: "write-failed",
            detail: "the OS refused to open the url",
          })
    } catch (cause) {
      return err({
        kind: "write-failed",
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

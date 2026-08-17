import type { PluginError } from "@spectrum/extensions"

/** Name the extension in the message when the error knows which one it was. */
const naming = (id: string | undefined, message: string): string =>
  id === undefined ? message : `${message} (extension "${id}")`

/**
 * The user-facing copy for a `PluginError` surfaced as a flow `error` step. Exhaustive over
 * the closed union.
 *
 * SECURITY: the error's `detail` is deliberately NOT included. A flow `PluginError` can be
 * built from a zod failure over a response an extension controls, and this string is rendered
 * verbatim in the setup modal. The kind is logged main-side instead (never the detail — the
 * same rule `@spectrum/secrets` applies to backend errors that can echo CLI output).
 */
export const flowErrorMessage = (error: PluginError): string => {
  switch (error.kind) {
    case "invalid-manifest":
      // The flow client reports an unparseable step this way: the extension sent something
      // outside the protocol this Spectrum understands.
      return naming(
        error.id,
        "Setup cannot continue: this step needs a newer Spectrum",
      )
    case "unsupported-api-version":
      return naming(
        error.id,
        "Setup cannot continue: this step needs a newer Spectrum",
      )
    case "not-found":
      // Either the contribution is gone/disabled, or the session ended before this call.
      return `Setup cannot continue: this extension does not offer that setup flow, or the flow has already ended (${error.id}).`
    case "read-failed":
      return "Setup was stopped: the extension stopped responding."
    case "write-failed":
      return "Setup was stopped: Spectrum could not run this step."
    case "duplicate-id":
      return `Setup cannot continue: two installed extensions both claim "${error.id}".`
    case "in-use":
      return `Setup cannot continue: extension "${error.id}" is in use.`
    case "git-failed":
      return "Setup cannot continue: the extension's source could not be read."
    case "source-unavailable":
      return "Setup cannot continue: the extension's files are no longer available."
  }
}

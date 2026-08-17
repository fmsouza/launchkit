import type { ReactElement } from "react"
import { Badge } from "../atoms/Badge"
import type { BadgeTone } from "../atoms/Badge"
import { Button } from "../atoms/Button"

/**
 * Where an installed extension's files come from — mirrors `ExtensionSource`
 * (`@spectrum/ipc`, `packages/ipc/src/extension-view.ts`) but redefined here rather than
 * imported: this package never depends on `@spectrum/ipc` (see `packages/ui/CLAUDE.md`).
 * A plain shape rather than a discriminated union — `kind` is read as a display key, not
 * narrowed on, so callers don't need `as const` on every literal.
 */
export type ExtensionSourceRow = {
  readonly kind: string
  readonly url?: string
  readonly ref?: string
  readonly commit?: string
  readonly path?: string
  readonly linked?: boolean
}

export type ContributedProviderStatusRow =
  | "stopped"
  | "starting"
  | "running"
  | "failed"

/**
 * One contributed provider as disclosed to the row. `launchArgs` is the UNRENDERED
 * template straight off the manifest (spec §3) — never interpolate it here, a rendered
 * arg can carry a resolved secret. There is no `env` field; never add one.
 */
export type ContributedProviderRow = {
  readonly key: string
  readonly label: string
  readonly status: ContributedProviderStatusRow
  readonly launchCommand?: string | undefined
  readonly launchArgs?: readonly string[] | undefined
  readonly secretFieldNames: readonly string[]
}

export type ExtensionRowData = {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly enabled: boolean
  readonly source: ExtensionSourceRow
  /** True when a linked source's directory has vanished — see `packages/ipc/CLAUDE.md`. */
  readonly unavailable: boolean
  readonly ignoredContributions: readonly string[]
  readonly providers: readonly ContributedProviderRow[]
}

export type ExtensionRowProps = {
  readonly extension: ExtensionRowData
  readonly onSetEnabled: (id: string, enabled: boolean) => void
  readonly onUpdate: (id: string) => void
  readonly onRemove: (id: string) => void
}

const sourceBadge = (
  source: ExtensionSourceRow,
): { readonly label: string; readonly tone: BadgeTone } => {
  if (source.kind === "git") return { label: "git", tone: "info" }
  if (source.kind === "path")
    return source.linked === true
      ? { label: "linked", tone: "warning" }
      : { label: "copied", tone: "info" }
  return { label: "local", tone: "neutral" }
}

/** Only a git install has an upstream to pull — link/copy/local have no update source. */
const canUpdate = (source: ExtensionSourceRow): boolean => source.kind === "git"

export const ExtensionRow = ({
  extension,
  onSetEnabled,
  onUpdate,
  onRemove,
}: ExtensionRowProps): ReactElement => {
  const badge = sourceBadge(extension.source)

  if (extension.unavailable) {
    return (
      <li className="lk-extension-row" data-unavailable="true">
        <div className="lk-extension-row__header">
          <span className="lk-extension-row__name">{extension.id}</span>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <Badge tone="danger">Unavailable</Badge>
        </div>
        <p className="lk-extension-row__sub">
          Source directory missing
          {extension.source.kind === "path" &&
          extension.source.path !== undefined
            ? ` — recorded at ${extension.source.path}`
            : ""}
        </p>
        <div className="lk-extension-row__actions">
          <Button variant="danger" onClick={() => onRemove(extension.id)}>
            Remove
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="lk-extension-row">
      <div className="lk-extension-row__header">
        <span className="lk-extension-row__name">{extension.name}</span>
        <span className="lk-extension-row__version">{extension.version}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <Badge tone={extension.enabled ? "success" : "neutral"}>
          {extension.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>

      {extension.ignoredContributions.length > 0 ? (
        <p className="lk-extension-row__ignored">
          Ignored contributions: {extension.ignoredContributions.join(", ")}
        </p>
      ) : null}

      <ul className="lk-extension-row__providers">
        {extension.providers.map((p) => (
          <li key={p.key} className="lk-extension-row__provider">
            <Badge
              tone={
                p.status === "running"
                  ? "success"
                  : p.status === "failed"
                    ? "danger"
                    : p.status === "starting"
                      ? "warning"
                      : "neutral"
              }
            >
              {`${p.label}: ${p.status}`}
            </Badge>
            {p.launchCommand !== undefined ? (
              <code className="lk-extension-row__command">
                {p.launchCommand}
                {p.launchArgs !== undefined && p.launchArgs.length > 0
                  ? ` ${p.launchArgs.join(" ")}`
                  : ""}
              </code>
            ) : null}
            {p.secretFieldNames.length > 0 ? (
              <span className="lk-extension-row__secrets">
                Secrets: {p.secretFieldNames.join(", ")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="lk-extension-row__actions">
        <Button
          variant="secondary"
          onClick={() => onSetEnabled(extension.id, !extension.enabled)}
        >
          {extension.enabled ? "Disable" : "Enable"}
        </Button>
        {canUpdate(extension.source) ? (
          <Button variant="secondary" onClick={() => onUpdate(extension.id)}>
            Update
          </Button>
        ) : null}
        <Button variant="danger" onClick={() => onRemove(extension.id)}>
          Remove
        </Button>
      </div>
    </li>
  )
}

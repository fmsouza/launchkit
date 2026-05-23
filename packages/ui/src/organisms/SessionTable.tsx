import type { ReactElement } from "react"
import type { Session } from "@launchkit/types"
import { Badge } from "../atoms/Badge"
import { EmptyState } from "../molecules/EmptyState"

export type SessionTableProps = {
  readonly sessions: readonly Session[]
  /** Render at most this many rows; the page virtualizes longer histories (performance.md). */
  readonly maxVisible?: number
}

export const SessionTable = ({ sessions, maxVisible }: SessionTableProps): ReactElement => {
  if (sessions.length === 0) {
    return <EmptyState title="No sessions yet" hint="Launched harnesses will appear here." />
  }
  const visible = maxVisible === undefined ? sessions : sessions.slice(0, maxVisible)
  const hidden = sessions.length - visible.length

  return (
    <div>
      <table>
        <thead>
          <tr>
            <th>Harness</th>
            <th>Alias</th>
            <th>Started</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((session) => (
            <tr key={session.id}>
              <td>{session.harnessId}</td>
              <td>{session.alias}</td>
              <td>{session.startedAt}</td>
              <td>
                {session.endedAt === undefined ? (
                  <Badge tone="info">running</Badge>
                ) : (
                  <Badge tone={session.exitCode === 0 ? "success" : "danger"}>{`exit ${session.exitCode ?? "?"}`}</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? <p>{`+${hidden} more`}</p> : null}
    </div>
  )
}

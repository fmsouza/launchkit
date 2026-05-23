import { useState } from "react"
import type { HarnessId } from "@launchkit/types"
import {
  Button,
  EmptyState,
  FormField,
  Select,
  SessionTable,
  SettingsLayout,
  Spinner,
} from "@launchkit/ui"
import { useHarnesses } from "../hooks/useHarnesses"
import { useSessions } from "../hooks/useSessions"

/** Page-level window size: render at most this many rows, raised by "show more". */
const PAGE_SIZE = 50

export const SessionsPage = (): JSX.Element => {
  const harnesses = useHarnesses()
  const [harnessFilter, setHarnessFilter] = useState<string>("")
  const [visible, setVisible] = useState<number>(PAGE_SIZE)

  const sessions = useSessions(harnessFilter === "" ? undefined : { harnessId: harnessFilter as HarnessId })

  const harnessOptions = [
    { value: "", label: "All harnesses" },
    ...(harnesses.data ?? []).map((h) => ({ value: h.id, label: h.name })),
  ]

  const total = sessions.data?.length ?? 0

  return (
    <SettingsLayout title="Sessions">
      <FormField id="session-harness-filter" label="Filter by harness">
        <Select
          id="session-harness-filter"
          value={harnessFilter}
          options={harnessOptions}
          onChange={(v) => {
            setVisible(PAGE_SIZE)
            setHarnessFilter(v)
          }}
        />
      </FormField>

      {sessions.loading ? <Spinner label="Loading sessions" /> : null}
      {sessions.error !== undefined ? (
        <EmptyState title="Could not load sessions" hint={`IPC error: ${sessions.error.kind}`} />
      ) : null}

      {sessions.data !== undefined ? (
        <>
          {/* Page owns windowing per performance.md; SessionTable renders <= maxVisible rows. */}
          <SessionTable sessions={sessions.data} maxVisible={visible} />
          {total > visible ? (
            <Button variant="secondary" onClick={() => setVisible((v) => v + PAGE_SIZE)}>
              {`Show more (${total - visible} hidden)`}
            </Button>
          ) : null}
        </>
      ) : null}
    </SettingsLayout>
  )
}

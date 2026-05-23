import { describe, it, expect, mock } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useSessions } from "./useSessions"

const Probe = ({ harnessId }: { readonly harnessId?: string }): JSX.Element => {
  const { data } = useSessions(harnessId === undefined ? undefined : { harnessId })
  return <span>{data === undefined ? "no-data" : `count:${data.length}`}</span>
}

describe("useSessions", () => {
  it("passes the filter through to getSessions when one is given", async () => {
    const getSessions = mock(async () => ({ ok: true as const, value: [] }))
    const client = createFakeIpcClient({ getSessions })
    render(<IpcClientProvider client={client}><Probe harnessId="claude" /></IpcClientProvider>)
    await waitFor(() => expect(getSessions).toHaveBeenCalled())
    expect(client.calls.getSessions[0]).toEqual({ harnessId: "claude" })
  })

  it("calls getSessions with undefined when no filter is given", async () => {
    const getSessions = mock(async () => ({ ok: true as const, value: [] }))
    const client = createFakeIpcClient({ getSessions })
    render(<IpcClientProvider client={client}><Probe /></IpcClientProvider>)
    await waitFor(() => expect(getSessions).toHaveBeenCalled())
    expect(client.calls.getSessions[0]).toBeUndefined()
  })
})

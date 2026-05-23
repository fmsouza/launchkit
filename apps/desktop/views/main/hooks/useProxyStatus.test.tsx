import { describe, it, expect } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import { IpcClientProvider } from "../IpcClientContext"
import { createFakeIpcClient } from "../test/fake-client"
import { useProxyStatus } from "./useProxyStatus"

const Probe = (): JSX.Element => {
  const { data } = useProxyStatus()
  return <span>{data === undefined ? "no-data" : data.running ? "running" : "stopped"}</span>
}

describe("useProxyStatus", () => {
  it("exposes the running status when the call resolves Ok", async () => {
    const client = createFakeIpcClient({
      getProxyStatus: async () => ({ ok: true, value: { running: true, port: 4000 } }),
    })
    render(<IpcClientProvider client={client}><Probe /></IpcClientProvider>)
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument())
  })
})

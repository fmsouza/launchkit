import { describe, it, expect } from "bun:test"
import { render, screen } from "@testing-library/react"
import { IpcClientProvider, useIpcClient } from "./IpcClientContext"
import { createFakeIpcClient } from "./test/fake-client"

const Probe = (): JSX.Element => {
  const client = useIpcClient()
  return <span>{typeof client.getProviders === "function" ? "has-client" : "no-client"}</span>
}

describe("useIpcClient", () => {
  it("returns the injected client when inside a provider", () => {
    const client = createFakeIpcClient({})
    render(
      <IpcClientProvider client={client}>
        <Probe />
      </IpcClientProvider>,
    )
    expect(screen.getByText("has-client")).toBeInTheDocument()
  })

  it("throws a descriptive error when used outside a provider", () => {
    expect(() => render(<Probe />)).toThrow(/IpcClientProvider/)
  })
})

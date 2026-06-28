import { describe, expect, it } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import type { ReactElement } from "react"
import { useStore } from "zustand"
import { createFakeIpcClient } from "../test/fake-client"
import { createUpdateClient } from "../update/updateClient"
import { StoreProvider, useStores } from "./createStores"

const Probe = (): ReactElement => {
  const store = useStores().proxy
  const running = useStore(store, (s) => s.data?.running ?? false)
  const fetch = useStore(store, (s) => s.fetch)
  return (
    <button type="button" onClick={() => void fetch()}>
      {running ? "running" : "stopped"}
    </button>
  )
}

const RunViewProbe = (): ReactElement => {
  const store = useStores().runView
  const apply = useStore(store, (s) => s.applyEvent)
  return (
    <button type="button" onClick={() => {}}>
      {typeof apply === "function" ? "wired" : "missing"}
    </button>
  )
}

describe("StoreProvider", () => {
  it("provides stores that read through to the injected client", async () => {
    const client = createFakeIpcClient({
      getProxyStatus: async () => ({
        ok: true,
        value: { running: true, port: 4000 },
      }),
    })
    render(
      <StoreProvider client={client} updateClient={createUpdateClient()}>
        <Probe />
      </StoreProvider>,
    )
    screen.getByRole("button").click()
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument())
  })

  it("provides a runView store of reduced RunState", () => {
    render(
      <StoreProvider
        client={createFakeIpcClient({})}
        updateClient={createUpdateClient()}
      >
        <RunViewProbe />
      </StoreProvider>,
    )
    expect(screen.getByText("wired")).toBeInTheDocument()
  })

  it("throws when useStores is used without a provider", () => {
    const Bad = (): ReactElement => {
      useStores()
      return <div />
    }
    expect(() => render(<Bad />)).toThrow(/StoreProvider/)
  })
})

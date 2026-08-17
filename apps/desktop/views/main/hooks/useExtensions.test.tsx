import { describe, expect, it, mock } from "bun:test"
import type { ExtensionView } from "@spectrum/ipc"
import type { PluginId } from "@spectrum/types"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import type { JSX } from "react"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { useExtensions } from "./useExtensions"

const view: ExtensionView = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  enabled: true,
  source: {
    kind: "git",
    url: "https://e.com/a.git",
    ref: "HEAD",
    commit: "c1",
  },
  unavailable: false,
  ignoredContributions: [],
  providers: [],
}

const updatedView: ExtensionView = { ...view, name: "Acme Updated" }

const Probe = (): JSX.Element => {
  const { extensions, loading, error, install, setEnabled, update, remove } =
    useExtensions()
  return (
    <div>
      <span>{loading ? "loading" : "idle"}</span>
      <span>{error === undefined ? "no-error" : error.detail}</span>
      <span>
        {extensions === undefined
          ? "no-data"
          : `count:${extensions.length}:${extensions[0]?.name ?? ""}`}
      </span>
      <button
        type="button"
        onClick={() => void install({ source: "/tmp/acme", mode: "link" })}
      >
        install
      </button>
      <button
        type="button"
        onClick={() => void setEnabled("acme" as PluginId, false)}
      >
        toggle
      </button>
      <button type="button" onClick={() => void update("acme" as PluginId)}>
        update
      </button>
      <button
        type="button"
        onClick={() =>
          void remove("acme" as PluginId).then((r) => {
            if (r.ok && r.value !== undefined) {
              document.title = `in-use:${r.value.providerIds.join(",")}`
            }
          })
        }
      >
        remove
      </button>
    </div>
  )
}

describe("useExtensions", () => {
  it("starts loading then exposes the data when the call resolves Ok", async () => {
    const client = createFakeIpcClient({
      listExtensions: async () => ({ ok: true, value: [view] }),
    })
    renderWithProviders(<Probe />, client)
    expect(screen.getByText("loading")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText("count:1:Acme")).toBeInTheDocument(),
    )
    expect(screen.getByText("idle")).toBeInTheDocument()
    expect(screen.getByText("no-error")).toBeInTheDocument()
  })

  it("exposes the typed error and no data when the call resolves Err", async () => {
    const client = createFakeIpcClient({
      listExtensions: async () => ({
        ok: false,
        error: {
          kind: "handler-failed",
          detail: 'invalid extension manifest for "acme": missing name',
        },
      }),
    })
    renderWithProviders(<Probe />, client)
    await waitFor(() =>
      expect(
        screen.getByText(/invalid extension manifest for "acme"/),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText("no-data")).toBeInTheDocument()
  })

  it("writes the mutation's returned list into the store without a second fetch", async () => {
    const listExtensions = mock(async () => ({
      ok: true as const,
      value: [view],
    }))
    const setExtensionEnabled = mock(async () => ({
      ok: true as const,
      value: [updatedView],
    }))
    const client = createFakeIpcClient({ listExtensions, setExtensionEnabled })
    renderWithProviders(<Probe />, client)
    await waitFor(() =>
      expect(screen.getByText("count:1:Acme")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    await waitFor(() =>
      expect(screen.getByText("count:1:Acme Updated")).toBeInTheDocument(),
    )
    // Only the initial mount fetch — the mutation's own response refreshed the store.
    expect(listExtensions).toHaveBeenCalledTimes(1)
  })

  it("resolves Ok with the refusal payload (not an error) when removal is refused as in-use", async () => {
    const client = createFakeIpcClient({
      listExtensions: async () => ({ ok: true, value: [view] }),
      removeExtension: async () => ({
        ok: true,
        value: { refused: { kind: "in-use", id: "acme", providerIds: ["p1"] } },
      }),
    })
    renderWithProviders(<Probe />, client)
    await waitFor(() =>
      expect(screen.getByText("count:1:Acme")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: "remove" }))
    await waitFor(() => expect(document.title).toBe("in-use:p1"))
  })
})

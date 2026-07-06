import { describe, expect, it } from "bun:test"
import { waitFor } from "@testing-library/react"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { useUpdate } from "./useUpdate"

const available = {
  phase: "available" as const,
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  latestHash: null,
  available: true,
  progress: 0,
  error: null,
  channel: "stable" as const,
  showBanner: true,
}

const Probe = (): null => {
  useUpdate()
  return null
}

describe("useUpdate", () => {
  it("runs a check on mount", async () => {
    let checked = false
    const client = createFakeIpcClient({
      checkForUpdate: async () => {
        checked = true
        return { ok: true, value: available }
      },
      getUpdateState: async () => ({ ok: true, value: available }),
    })
    renderWithProviders(<Probe />, client)
    await waitFor(() => expect(checked).toBe(true))
  })

  it("exposes the update state returned by checkForUpdate", async () => {
    let capturedState: ReturnType<typeof useUpdate>["state"]
    const StateProbe = (): null => {
      const { state } = useUpdate()
      capturedState = state
      return null
    }
    const client = createFakeIpcClient({
      checkForUpdate: async () => ({ ok: true, value: available }),
      getUpdateState: async () => ({ ok: true, value: available }),
    })
    renderWithProviders(<StateProbe />, client)
    await waitFor(() => expect(capturedState?.phase).toBe("available"))
    expect(capturedState?.latestVersion).toBe("1.1.0")
  })

  it("polls refresh while downloading", async () => {
    let refreshCount = 0
    const downloading = {
      ...available,
      phase: "downloading" as const,
      progress: 0.5,
    }
    const client = createFakeIpcClient({
      checkForUpdate: async () => ({ ok: true, value: downloading }),
      getUpdateState: async () => {
        refreshCount++
        return { ok: true, value: downloading }
      },
    })
    renderWithProviders(<Probe />, client)
    // Wait for at least one poll (DOWNLOAD_POLL_MS = 800ms, but we just wait for a refresh call)
    await waitFor(() => expect(refreshCount).toBeGreaterThanOrEqual(1), {
      timeout: 3000,
    })
  })
})

import { describe, expect, it } from "bun:test"
import { ok } from "@spectrum/utils"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { UpdatesPage } from "./UpdatesPage"

const upToDate = {
  phase: "up-to-date" as const,
  currentVersion: "1.0.0",
  latestVersion: null,
  latestHash: null,
  available: false,
  progress: 0,
  error: null,
  channel: "stable" as const,
  showBanner: false,
}

const defaultTimeouts = {
  firstTokenTimeoutMs: 120000,
  interTokenTimeoutMs: 60000,
}

describe("UpdatesPage updates section", () => {
  it("shows the current version", async () => {
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(upToDate),
        getUpdateState: async () => ok(upToDate),
        getTimeoutSettings: async () => ok(defaultTimeouts),
      }),
    )
    await waitFor(() => expect(screen.getByText(/1\.0\.0/)).toBeTruthy())
  })

  it("shows the canary version with the -canary.N suffix and channel word", async () => {
    const canaryState = {
      ...upToDate,
      currentVersion: "1.2.3-canary.7",
      channel: "canary" as const,
    }
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(canaryState),
        getUpdateState: async () => ok(canaryState),
        getTimeoutSettings: async () => ok(defaultTimeouts),
      }),
    )
    await waitFor(() =>
      expect(screen.getByText(/1\.2\.3-canary\.7 · canary/)).toBeTruthy(),
    )
  })

  it("switches channel when the canary toggle is chosen", async () => {
    let chosen: string | null = null
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(upToDate),
        getUpdateState: async () => ok(upToDate),
        getTimeoutSettings: async () => ok(defaultTimeouts),
        setUpdateChannel: async ({ channel }) => {
          chosen = channel
          return ok({ ...upToDate, channel })
        },
      }),
    )
    await waitFor(() => screen.getByLabelText(/canary/i))
    fireEvent.click(screen.getByLabelText(/canary/i))
    await waitFor(() => expect(chosen).toBe("canary"))
  })
})

describe("UpdatesPage update actions", () => {
  const available = {
    ...upToDate,
    phase: "available" as const,
    latestVersion: "1.1.0",
    available: true,
    showBanner: true,
  }
  const downloading = {
    ...available,
    phase: "downloading" as const,
    progress: 0.5,
  }
  const downloaded = {
    ...available,
    phase: "downloaded" as const,
    progress: 1,
  }

  it("downloads the update when the download button is clicked in the available phase", async () => {
    let downloadStarted = false
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(available),
        getUpdateState: async () => ok(available),
        getTimeoutSettings: async () => ok(defaultTimeouts),
        startUpdateDownload: async () => {
          downloadStarted = true
          return ok(null)
        },
      }),
    )
    const button = await screen.findByRole("button", {
      name: /download update/i,
    })
    fireEvent.click(button)
    await waitFor(() => expect(downloadStarted).toBe(true))
  })

  it("applies the update when the restart button is clicked in the downloaded phase", async () => {
    let applied = false
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(downloaded),
        getUpdateState: async () => ok(downloaded),
        getTimeoutSettings: async () => ok(defaultTimeouts),
        applyUpdate: async () => {
          applied = true
          return ok(null)
        },
      }),
    )
    const button = await screen.findByRole("button", {
      name: /restart to apply/i,
    })
    fireEvent.click(button)
    await waitFor(() => expect(applied).toBe(true))
  })

  it("shows a disabled downloading button in the downloading phase", async () => {
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(downloading),
        getUpdateState: async () => ok(downloading),
        getTimeoutSettings: async () => ok(defaultTimeouts),
      }),
    )
    const button = await screen.findByRole("button", { name: /downloading/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows no update action button when up to date", async () => {
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(upToDate),
        getUpdateState: async () => ok(upToDate),
        getTimeoutSettings: async () => ok(defaultTimeouts),
      }),
    )
    await waitFor(() => screen.getByText(/up to date/i))
    expect(
      screen.queryByRole("button", { name: /download update/i }),
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: /restart to apply/i }),
    ).toBeNull()
    expect(screen.queryByRole("button", { name: /downloading/i })).toBeNull()
  })
})

describe("UpdatesPage timeout settings section", () => {
  it("renders the two timeout fields populated with values from getTimeoutSettings", async () => {
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(upToDate),
        getUpdateState: async () => ok(upToDate),
        getTimeoutSettings: async () =>
          ok({ firstTokenTimeoutMs: 120000, interTokenTimeoutMs: 60000 }),
      }),
    )
    await waitFor(() => {
      const firstInput = screen.getByLabelText(/first.token timeout/i)
      const interInput = screen.getByLabelText(/inter.token timeout/i)
      expect((firstInput as HTMLInputElement).value).toBe("120000")
      expect((interInput as HTMLInputElement).value).toBe("60000")
    })
  })

  it("calls updateTimeoutSettings with new firstToken and unchanged interToken on blur", async () => {
    let captured: {
      firstTokenTimeoutMs: number
      interTokenTimeoutMs: number
    } | null = null
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(upToDate),
        getUpdateState: async () => ok(upToDate),
        getTimeoutSettings: async () =>
          ok({ firstTokenTimeoutMs: 120000, interTokenTimeoutMs: 60000 }),
        updateTimeoutSettings: async (params) => {
          captured = params
          return ok(null)
        },
      }),
    )
    await waitFor(() => screen.getByLabelText(/first.token timeout/i))
    const firstInput = screen.getByLabelText(/first.token timeout/i)
    fireEvent.change(firstInput, { target: { value: "90000" } })
    fireEvent.blur(firstInput)
    await waitFor(() =>
      expect(captured).toEqual({
        firstTokenTimeoutMs: 90000,
        interTokenTimeoutMs: 60000,
      }),
    )
  })

  it("shows a validation error and does not call updateTimeoutSettings when an out-of-bounds value is entered", async () => {
    let saveCalled = false
    renderWithProviders(
      <UpdatesPage />,
      createFakeIpcClient({
        checkForUpdate: async () => ok(upToDate),
        getUpdateState: async () => ok(upToDate),
        getTimeoutSettings: async () =>
          ok({ firstTokenTimeoutMs: 120000, interTokenTimeoutMs: 60000 }),
        updateTimeoutSettings: async () => {
          saveCalled = true
          return ok(null)
        },
      }),
    )
    await waitFor(() => screen.getByLabelText(/first.token timeout/i))
    const firstInput = screen.getByLabelText(/first.token timeout/i)
    fireEvent.change(firstInput, { target: { value: "100" } })
    fireEvent.blur(firstInput)
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(saveCalled).toBe(false)
  })
})

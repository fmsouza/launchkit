import { describe, expect, it, mock } from "bun:test"
import type { ModelId, ProviderId } from "@spectrum/types"
import { ok } from "@spectrum/utils"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { GeneralPage } from "./GeneralPage"

const sampleModels = [
  {
    id: "mdl_1" as ModelId,
    providerId: "prv_1" as ProviderId,
    providerModel: "gpt-4o",
    aliases: [] as string[],
    attachments: {},
  },
  {
    id: "mdl_2" as ModelId,
    providerId: "prv_2" as ProviderId,
    providerModel: "claude-3-5-haiku",
    aliases: [] as string[],
    attachments: {},
  },
]
const sampleProviders = [
  {
    id: "prv_1" as ProviderId,
    name: "OpenAI",
    sdkProvider: "openai" as const,
    config: {},
    secretFields: {},
    models: ["gpt-4o"],
  },
  {
    id: "prv_2" as ProviderId,
    name: "Anthropic",
    sdkProvider: "anthropic" as const,
    config: {},
    secretFields: {},
    models: ["claude-3-5-haiku"],
  },
]

describe("GeneralPage session-name picker", () => {
  it("renders the Off option and each model", async () => {
    renderWithProviders(
      <GeneralPage />,
      createFakeIpcClient({
        getModels: async () => ok(sampleModels),
        getProviders: async () => ok(sampleProviders),
        getSessionNamingSettings: async () => ok({ sessionNameModelId: null }),
      }),
    )
    await waitFor(() =>
      expect(screen.getByText(/Off — use first prompt/i)).toBeTruthy(),
    )
    expect(screen.getByText(/gpt-4o · OpenAI/i)).toBeTruthy()
    expect(screen.getByText(/claude-3-5-haiku · Anthropic/i)).toBeTruthy()
  })

  it("selects a model and persists its id", async () => {
    const saveMock = mock(async () => ok(null))
    renderWithProviders(
      <GeneralPage />,
      createFakeIpcClient({
        getModels: async () => ok(sampleModels),
        getProviders: async () => ok(sampleProviders),
        getSessionNamingSettings: async () => ok({ sessionNameModelId: null }),
        updateSessionNamingSettings: saveMock,
      }),
    )
    await waitFor(() =>
      expect(screen.getByText(/Off — use first prompt/i)).toBeTruthy(),
    )
    const select = screen.getByLabelText(/Auto-name model/i)
    fireEvent.change(select, { target: { value: "mdl_1" } })
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ sessionNameModelId: "mdl_1" }),
    )
  })

  it("selecting Off persists null", async () => {
    const saveMock = mock(async () => ok(null))
    renderWithProviders(
      <GeneralPage />,
      createFakeIpcClient({
        getModels: async () => ok(sampleModels),
        getProviders: async () => ok(sampleProviders),
        getSessionNamingSettings: async () =>
          ok({ sessionNameModelId: "mdl_1" }),
        updateSessionNamingSettings: saveMock,
      }),
    )
    await waitFor(() =>
      expect(screen.getByText(/gpt-4o · OpenAI/i)).toBeTruthy(),
    )
    const select = screen.getByLabelText(/Auto-name model/i)
    fireEvent.change(select, { target: { value: "" } })
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ sessionNameModelId: null }),
    )
  })

  it("shows Off selected when the saved id matches no current model (dangling)", async () => {
    renderWithProviders(
      <GeneralPage />,
      createFakeIpcClient({
        getModels: async () => ok(sampleModels),
        getProviders: async () => ok(sampleProviders),
        getSessionNamingSettings: async () =>
          ok({ sessionNameModelId: "mdl_deleted" }),
      }),
    )
    await waitFor(() =>
      expect(screen.getByText(/Off — use first prompt/i)).toBeTruthy(),
    )
    const select = screen.getByLabelText(
      /Auto-name model/i,
    ) as HTMLSelectElement
    expect(select.value).toBe("")
  })
})

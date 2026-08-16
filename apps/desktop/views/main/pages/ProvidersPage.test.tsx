import { describe, expect, it } from "bun:test"
import type { ProviderView } from "@spectrum/ipc"
import type { ProviderCatalogEntry } from "@spectrum/providers"
import type { ProviderId } from "@spectrum/types"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { Toasts } from "../test/Toasts"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { ProvidersPage } from "./ProvidersPage"

const view: ProviderView = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: { baseUrl: "https://api.openai.com/v1" },
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o"],
} as unknown as ProviderView

/** Minimal catalog used as default stub in all tests. */
const defaultProviderActions: ProviderCatalogEntry["actions"] = [
  { kind: "edit-config", id: "edit", label: "Edit", context: "both" },
  { kind: "set-secrets", id: "secrets", label: "Set secret", context: "both" },
]

const defaultCatalog: ProviderCatalogEntry[] = [
  {
    key: "openai",
    label: "OpenAI",
    configFields: [],
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    supportsCustomHeaders: false,
    actions: defaultProviderActions,
  },
  {
    key: "groq",
    label: "Groq",
    configFields: [],
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    supportsCustomHeaders: false,
    actions: defaultProviderActions,
  },
  {
    key: "custom",
    label: "Custom (OpenAI-compatible)",
    configFields: [
      {
        name: "serverUrl",
        label: "Server URL",
        kind: "url",
        required: false,
      },
      {
        name: "headers",
        label: "Custom headers",
        kind: "headers",
        required: false,
      },
    ],
    secretFields: [{ name: "apiKey", label: "API key", required: false }],
    supportsCustomHeaders: true,
    actions: defaultProviderActions,
  },
]

const renderPage = (stubs: Parameters<typeof createFakeIpcClient>[0]) => {
  const client = createFakeIpcClient({
    getProviders: async () => ({ ok: true, value: [view] }),
    getProviderCatalog: async () => ({
      ok: true,
      value: defaultCatalog,
    }),
    ...stubs,
  })
  renderWithProviders(
    <>
      <ProvidersPage />
      <Toasts />
    </>,
    client,
  )
  return client
}

describe("ProvidersPage", () => {
  it("renders a table once providers load (consistent with Models page)", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    expect(document.querySelector("table")).not.toBeNull()
  })

  it("shows the provider name, SDK badge, and Set badge in the table row", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    // Provider name cell
    expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument()
    // SDK badge — info tone
    const infoBadge = document.querySelector("span[data-tone='info']")
    expect(infoBadge?.textContent).toBe("openai")
    // secretSet = true → "Set" badge
    const successBadge = document.querySelector("span[data-tone='success']")
    expect(successBadge?.textContent).toBe("Set")
  })

  it("renders the Set secret button inside lk-cell-actions in the provider's row", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions")
    expect(actionsCell).not.toBeNull()
    expect(
      within(actionsCell as HTMLElement).getByRole("button", {
        name: /set secret/i,
      }),
    ).toBeInTheDocument()
  })

  it("does NOT render a separate 'Provider secrets' list", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    const secretsList = document.querySelector(
      "ul[aria-label='Provider secrets']",
    )
    expect(secretsList).toBeNull()
  })

  it("does NOT render an article or the old lk-list-row--card style", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    expect(document.querySelector("article")).toBeNull()
    expect(document.querySelector(".lk-list-row--card")).toBeNull()
  })

  it("wraps the add-provider form action buttons in lk-form-actions row", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    const actionsRow = document.querySelector(".lk-row.lk-form-actions")
    expect(actionsRow).not.toBeNull()
    // buttons must NOT be direct children of the form
    const form = document.querySelector("form[aria-label='Add provider']")
    const directButtons = Array.from(form?.children ?? []).filter(
      (c) => c.tagName === "BUTTON",
    )
    expect(directButtons.length).toBe(0)
  })

  it("wraps the set-secret form action buttons in lk-form-actions row", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    // Trigger the set-secret form from the table row
    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /set secret/i }),
    )
    const secretForm = document.querySelector(
      "form[aria-label='Set secret for OpenAI']",
    )
    expect(secretForm).not.toBeNull()
    const actionsRow = secretForm?.querySelector(".lk-row.lk-form-actions")
    expect(actionsRow).not.toBeNull()
    // buttons must NOT be direct children of the form
    const directButtons = Array.from(secretForm?.children ?? []).filter(
      (c) => c.tagName === "BUTTON",
    )
    expect(directButtons.length).toBe(0)
  })

  it("renders the provider's declared secret fields (not a free-text field-name input)", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /set secret/i }),
    )
    const form = document.querySelector(
      "form[aria-label='Set secret for OpenAI']",
    ) as HTMLElement
    // declared catalog secret field renders as a labeled password input ...
    const apiKey = within(form).getByLabelText("API key") as HTMLInputElement
    expect(apiKey.type).toBe("password")
    // ... and the old free-text "Secret field" input is gone
    expect(within(form).queryByLabelText("Secret field")).toBeNull()
  })

  it("calls setProviderSecret with the typed value when the secret form is submitted", async () => {
    const client = renderPage({
      setProviderSecret: async () => ({ ok: true, value: null }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    // Open via table row's Set secret button
    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /set secret/i }),
    )
    const form = document.querySelector(
      "form[aria-label='Set secret for OpenAI']",
    ) as HTMLElement
    fireEvent.change(within(form).getByLabelText("API key"), {
      target: { value: "sk-secret-123" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }))

    await waitFor(() => expect(client.calls.setProviderSecret.length).toBe(1))
    expect(client.calls.setProviderSecret[0]).toEqual({
      providerId: "p_openai" as ProviderId,
      field: "apiKey",
      value: "sk-secret-123",
    })
    await waitFor(() =>
      expect(
        document.querySelector("form[aria-label='Set secret for OpenAI']"),
      ).toBeNull(),
    )
  })

  it("never re-displays the secret value after submitting it", async () => {
    const client = renderPage({
      setProviderSecret: async () => ({ ok: true, value: null }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /set secret/i }),
    )
    const form = document.querySelector(
      "form[aria-label='Set secret for OpenAI']",
    ) as HTMLElement
    fireEvent.change(within(form).getByLabelText("API key"), {
      target: { value: "sk-secret-123" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }))

    await waitFor(() => expect(client.calls.setProviderSecret.length).toBe(1))
    // The write-only form clears and the value is not echoed anywhere.
    expect(screen.queryByDisplayValue("sk-secret-123")).toBeNull()
  })

  it("renders the add-provider form inside a modal dialog", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))

    const dialog = await screen.findByRole("dialog", { name: /add provider/i })
    expect(
      dialog.querySelector("form[aria-label='Add provider']"),
    ).not.toBeNull()
  })

  it("closes the add-provider modal when Cancel is clicked", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    await screen.findByRole("dialog", { name: /add provider/i })
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))

    expect(screen.queryByRole("dialog", { name: /add provider/i })).toBeNull()
  })

  it("submits the add-provider form with config, secret field names, and chosen model", async () => {
    const client = renderPage({
      addProvider: async () => ({ ok: true, value: view }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    fireEvent.change(screen.getByLabelText("Provider name"), {
      target: { value: "Groq" },
    })
    fireEvent.change(screen.getByLabelText("SDK provider"), {
      target: { value: "groq" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }))

    await waitFor(() => expect(client.calls.addProvider.length).toBe(1))
    const params = client.calls.addProvider[0]
    expect(params).toMatchObject({ name: "Groq", sdkProvider: "groq" })
  })

  it("renders the selected provider's secret fields from the catalog", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    const apiKey = screen.getByLabelText("API key") as HTMLInputElement
    expect(apiKey.type).toBe("password")
  })

  it("the add modal has no Discover models button and no model field", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    await screen.findByRole("dialog", { name: /add provider/i })
    expect(
      screen.queryByRole("button", { name: /discover models/i }),
    ).toBeNull()
    expect(screen.queryByLabelText("Model")).toBeNull()
  })

  it("tests the connection with the entered config + secrets; auto-picks first discovered model", async () => {
    const client = renderPage({
      listProviderModelsDraft: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }] },
      }),
      testProviderDraft: async () => ({
        ok: true,
        value: { ok: true, latencyMs: 11 },
      }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-x" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))
    await waitFor(() => expect(client.calls.testProviderDraft.length).toBe(1))
    expect(client.calls.testProviderDraft[0]).toMatchObject({
      sdkProvider: "openai",
      secrets: { apiKey: "sk-x" },
      providerModel: "gpt-4o",
    })
  })

  it("creates the provider with inline secrets and no preset models", async () => {
    const client = renderPage({
      addProvider: async () => ({ ok: true, value: view }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-x" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }))
    await waitFor(() => expect(client.calls.addProvider.length).toBe(1))
    expect(client.calls.addProvider[0]).toMatchObject({
      sdkProvider: "openai",
      secrets: { apiKey: "sk-x" },
      models: [],
    })
  })

  it("renders the Server URL field when Custom is selected in the add form", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    // Open the add-provider modal
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    await screen.findByRole("dialog", { name: /add provider/i })

    // Select the "custom" SDK provider
    fireEvent.change(screen.getByLabelText("SDK provider"), {
      target: { value: "custom" },
    })

    // The catalog-driven ProviderForm should render the Server URL field
    await waitFor(() =>
      expect(screen.getByLabelText("Server URL")).toBeInTheDocument(),
    )
  })

  it("opens edit modal pre-filled with current config when Edit is clicked", async () => {
    const customView: ProviderView = {
      id: "p_custom",
      name: "My Custom",
      sdkProvider: "custom",
      config: { serverUrl: "http://old:1/v1" },
      secretFields: {},
      models: [],
    } as unknown as ProviderView

    renderPage({
      getProviders: async () => ({ ok: true, value: [customView] }),
    })

    await waitFor(() =>
      expect(
        screen.getByRole("cell", { name: "My Custom" }),
      ).toBeInTheDocument(),
    )

    // Click the Edit button in the table row
    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /^edit$/i }),
    )

    // Edit modal opens and Server URL field is pre-filled
    await screen.findByRole("dialog", { name: /edit provider/i })
    const serverUrlInput = screen.getByLabelText(
      "Server URL",
    ) as HTMLInputElement
    expect(serverUrlInput.value).toBe("http://old:1/v1")
  })

  it("omits the secrets key from addProvider params when no secret is entered", async () => {
    const client = renderPage({
      addProvider: async () => ({ ok: true, value: view }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    // Do NOT type into the API key field — leave secrets empty
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }))

    await waitFor(() => expect(client.calls.addProvider.length).toBe(1))
    const params = client.calls.addProvider[0]
    expect(params).not.toHaveProperty("secrets")
  })

  it("clears entered secret values when the add modal is cancelled", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-secret" },
    })

    // Cancel via the Cancel button inside the Add provider form
    const addForm = document.querySelector(
      "form[aria-label='Add provider']",
    ) as HTMLElement
    fireEvent.click(within(addForm).getByRole("button", { name: /cancel/i }))

    // Reopen the modal — the API key field must be empty
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    )
  })

  it("omits empty-string config values when testing the connection", async () => {
    const client = renderPage({
      listProviderModelsDraft: async () => ({
        ok: true,
        value: { models: [{ id: "m1" }] },
      }),
      testProviderDraft: async () => ({
        ok: true,
        value: { ok: true, latencyMs: 5 },
      }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    fireEvent.change(screen.getByLabelText("SDK provider"), {
      target: { value: "custom" },
    })
    // Wait for the Server URL field to appear
    await waitFor(() =>
      expect(screen.getByLabelText("Server URL")).toBeInTheDocument(),
    )
    // type then clear the Server URL config field
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://x" },
    })
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))
    await waitFor(() =>
      expect(client.calls.listProviderModelsDraft.length).toBeGreaterThan(0),
    )
    const sent = client.calls.listProviderModelsDraft.at(-1) as {
      config: Record<string, string>
    }
    expect(sent.config).not.toHaveProperty("serverUrl")
  })

  it("shows the discovery error detail inline when Test connection's discovery fails", async () => {
    renderPage({
      listProviderModelsDraft: async () => ({
        ok: false,
        error: {
          kind: "handler-failed",
          detail:
            "could not list provider models: HTTP 404 from http://x/models",
        },
      }),
      testProviderDraft: async () => ({
        ok: true,
        value: { ok: false, latencyMs: 0 },
      }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-x" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))
    await screen.findByText(/HTTP 404 from http:\/\/x\/models/)
  })

  // ── Notification tests ────────────────────────────────────────────────────

  it("shows an error toast when adding a provider fails", async () => {
    renderPage({
      addProvider: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "x" },
      }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add provider/i }))
    await screen.findByRole("dialog", { name: /add provider/i })

    // Fill required secret field so the form can submit
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-x" },
    })
    fireEvent.click(screen.getByRole("button", { name: /create provider/i }))

    await screen.findByText("Couldn't add the provider")
  })

  it("shows an error toast when saving a secret fails", async () => {
    renderPage({
      setProviderSecret: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "x" },
      }),
    })
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "OpenAI" })).toBeInTheDocument(),
    )

    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /set secret/i }),
    )
    const form = document.querySelector(
      "form[aria-label='Set secret for OpenAI']",
    ) as HTMLElement
    fireEvent.change(within(form).getByLabelText("API key"), {
      target: { value: "sk-secret-123" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save secret/i }))

    await screen.findByText("Couldn't save the secret")
  })

  it("shows an error toast when saving an edited provider fails", async () => {
    const customView: ProviderView = {
      id: "p_custom",
      name: "My Custom",
      sdkProvider: "custom",
      config: { serverUrl: "http://old:1/v1" },
      secretFields: {},
      models: [],
    } as unknown as ProviderView

    renderPage({
      getProviders: async () => ({ ok: true, value: [customView] }),
      updateProvider: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "x" },
      }),
    })

    await waitFor(() =>
      expect(
        screen.getByRole("cell", { name: "My Custom" }),
      ).toBeInTheDocument(),
    )

    // Open the Edit modal for the existing provider row
    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /^edit$/i }),
    )

    await screen.findByRole("dialog", { name: /edit provider/i })

    // Change the Server URL and submit
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://new:2/v1" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }))

    await screen.findByText("Couldn't save the provider")
  })

  it("calls updateProvider with updated config when edit form is saved", async () => {
    const customView: ProviderView = {
      id: "p_custom",
      name: "My Custom",
      sdkProvider: "custom",
      config: { serverUrl: "http://old:1/v1" },
      secretFields: {},
      models: [],
    } as unknown as ProviderView

    const client = renderPage({
      getProviders: async () => ({ ok: true, value: [customView] }),
      updateProvider: async () => ({ ok: true, value: customView }),
    })

    await waitFor(() =>
      expect(
        screen.getByRole("cell", { name: "My Custom" }),
      ).toBeInTheDocument(),
    )

    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /^edit$/i }),
    )

    await screen.findByRole("dialog", { name: /edit provider/i })

    // Change the Server URL value
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://new:2/v1" },
    })

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }))

    await waitFor(() => expect(client.calls.updateProvider.length).toBe(1))
    expect(client.calls.updateProvider[0]).toMatchObject({
      id: "p_custom",
      input: expect.objectContaining({
        config: { serverUrl: "http://new:2/v1" },
      }),
    })
  })

  it("omits an emptied optional config field when the edit form is saved", async () => {
    const customView: ProviderView = {
      id: "p_custom",
      name: "My Custom",
      sdkProvider: "custom",
      config: { serverUrl: "http://old:1/v1" },
      secretFields: {},
      models: [],
    } as unknown as ProviderView

    const client = renderPage({
      getProviders: async () => ({ ok: true, value: [customView] }),
      updateProvider: async () => ({ ok: true, value: customView }),
    })

    await waitFor(() =>
      expect(
        screen.getByRole("cell", { name: "My Custom" }),
      ).toBeInTheDocument(),
    )

    const row = document.querySelector("tbody tr") as HTMLElement
    const actionsCell = row.querySelector("td.lk-cell-actions") as HTMLElement
    fireEvent.click(
      within(actionsCell).getByRole("button", { name: /^edit$/i }),
    )

    await screen.findByRole("dialog", { name: /edit provider/i })

    // Clear the previously-set Server URL and submit
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "" },
    })

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }))

    await waitFor(() => expect(client.calls.updateProvider.length).toBe(1))
    expect(client.calls.updateProvider[0]).toMatchObject({
      id: "p_custom",
      input: expect.objectContaining({
        config: {},
      }),
    })
  })
})

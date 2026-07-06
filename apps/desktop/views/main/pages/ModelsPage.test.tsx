import { describe, expect, it } from "bun:test"
import type { ProviderView } from "@spectrum/ipc"
import type { ModelRoute } from "@spectrum/types"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { Toasts } from "../test/Toasts"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { ModelsPage } from "./ModelsPage"

const model = {
  id: "m_1",
  providerId: "p_openai",
  providerModel: "gpt-4o-mini",
  aliases: ["haiku", "small"],
  attachments: {},
} as unknown as ModelRoute
const view = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: {},
  secretFields: {},
  models: ["gpt-4o-mini"],
} as unknown as ProviderView

const renderPage = (stubs: Parameters<typeof createFakeIpcClient>[0]) => {
  const client = createFakeIpcClient({
    getModels: async () => ({ ok: true, value: [model] }),
    getProviders: async () => ({ ok: true, value: [view] }),
    // Default: return empty models (no discovery) so existing tests don't break.
    listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    ...stubs,
  })
  renderWithProviders(
    <>
      <ModelsPage />
      <Toasts />
    </>,
    client,
  )
  return client
}

describe("ModelsPage", () => {
  it("wraps the add-model form action buttons in lk-form-actions row", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    await waitFor(() =>
      expect(screen.getByLabelText("Provider")).toBeInTheDocument(),
    )
    const actionsRow = document.querySelector(".lk-row.lk-form-actions")
    expect(actionsRow).not.toBeNull()
    // buttons must NOT be direct children of the form
    const form = document.querySelector("form[aria-label='Add model']")
    const directButtons = Array.from(form?.children ?? []).filter(
      (c) => c.tagName === "BUTTON",
    )
    expect(directButtons.length).toBe(0)
  })

  it("renders the add-model form inside a modal dialog", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add model/i }))

    const dialog = await screen.findByRole("dialog", { name: /add model/i })
    expect(dialog.querySelector("form[aria-label='Add model']")).not.toBeNull()
  })

  it("closes the add-model modal when Cancel is clicked", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    await screen.findByRole("dialog", { name: /add model/i })
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))

    expect(screen.queryByRole("dialog", { name: /add model/i })).toBeNull()
  })

  it("wraps the edit-model form action buttons in lk-form-actions row", async () => {
    renderPage({
      updateModel: async () => ({ ok: true, value: model }),
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini"),
    )
    const editForm = document.querySelector("form[aria-label='Edit model']")
    expect(editForm).not.toBeNull()
    const actionsRow = editForm?.querySelector(".lk-row.lk-form-actions")
    expect(actionsRow).not.toBeNull()
    // buttons must NOT be direct children of the form
    const directButtons = Array.from(editForm?.children ?? []).filter(
      (c) => c.tagName === "BUTTON",
    )
    expect(directButtons.length).toBe(0)
  })

  it("renders the Models heading when loaded", async () => {
    renderPage({})
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /models/i }),
      ).toBeInTheDocument(),
    )
  })

  it("renders each model with its resolved provider name when loaded", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("does not render an 'Alias name' input in the add form", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    expect(screen.queryByLabelText(/alias name/i)).toBeNull()
  })

  it("calls addModel with the provider and model when the add form is submitted", async () => {
    const client = renderPage({
      addModel: async (p) => ({
        ok: true,
        value: { id: "m_2", ...p } as unknown as ModelRoute,
      }),
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))

    await waitFor(() => expect(client.calls.addModel.length).toBe(1))
    expect(client.calls.addModel[0]).toEqual({
      providerId: "p_openai",
      providerModel: "gpt-4o",
      aliases: [],
      attachments: { image: true, pdf: false },
      attachmentsSource: "auto",
    })
  })

  it("calls deleteModel with the model id when a row is deleted", async () => {
    const client = renderPage({
      deleteModel: async () => ({ ok: true, value: null }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    await waitFor(() => expect(client.calls.deleteModel.length).toBe(1))
    expect(client.calls.deleteModel[0]).toEqual({ id: "m_1" })
  })

  it("seeds the edit form and calls updateModel when an existing model is edited", async () => {
    const client = renderPage({
      updateModel: async () => ({ ok: true, value: model }),
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini"),
    )
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))

    await waitFor(() => expect(client.calls.updateModel.length).toBe(1))
    expect(client.calls.updateModel[0]).toEqual({
      id: "m_1",
      input: {
        providerId: "p_openai",
        providerModel: "gpt-4o",
        aliases: ["haiku", "small"],
        attachments: { image: true, pdf: false },
        attachmentsSource: "auto",
      },
    })
  })

  // ── Model discovery tests ──────────────────────────────────────────────────

  it("calls listProviderModels when a provider is selected in the add-model form", async () => {
    const client = renderPage({
      addModel: async (p) => ({
        ok: true,
        value: { id: "m_2", ...p } as unknown as ModelRoute,
      }),
      listProviderModels: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] },
      }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })

    await waitFor(() =>
      expect(client.calls.listProviderModels.length).toBeGreaterThan(0),
    )
    expect(client.calls.listProviderModels[0]).toEqual({
      providerId: "p_openai",
    })
  })

  it("renders a Model <Select> with discovered models when listProviderModels returns a non-empty list", async () => {
    renderPage({
      listProviderModels: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] },
      }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })

    await waitFor(() => {
      const el = screen.getByLabelText("Model") as HTMLSelectElement
      expect(el.tagName).toBe("SELECT")
      const values = Array.from(el.options).map((o) => o.value)
      expect(values).toContain("gpt-4o")
      expect(values).toContain("gpt-4o-mini")
    })
  })

  it("falls back to a TextInput with a note when listProviderModels returns an empty list", async () => {
    renderPage({
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })

    await waitFor(() => {
      const el = screen.getByLabelText("Model")
      expect(el.tagName).toBe("INPUT")
    })
    expect(screen.getByText(/couldn't list models/i)).toBeInTheDocument()
  })

  it("falls back to a TextInput with a note when listProviderModels errors (unsupported SDK)", async () => {
    renderPage({
      listProviderModels: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "unsupported" },
      }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })

    await waitFor(() => {
      const el = screen.getByLabelText("Model")
      expect(el.tagName).toBe("INPUT")
    })
    expect(screen.getByText(/couldn't list models/i)).toBeInTheDocument()
  })

  it("creating a model with a model picked from the Select calls addModel with that model", async () => {
    const client = renderPage({
      addModel: async (p) => ({
        ok: true,
        value: { id: "m_2", ...p } as unknown as ModelRoute,
      }),
      listProviderModels: async () => ({
        ok: true,
        value: { models: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] },
      }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })

    await waitFor(() => {
      const el = screen.getByLabelText("Model")
      expect(el.tagName).toBe("SELECT")
    })
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))

    await waitFor(() => expect(client.calls.addModel.length).toBe(1))
    expect(client.calls.addModel[0]).toEqual({
      providerId: "p_openai",
      providerModel: "gpt-4o",
      aliases: [],
      attachments: { image: true, pdf: false },
      attachmentsSource: "auto",
    })
  })

  // ── Bug-fix tests: placeholder, defaulting, and save-disabled ─────────────

  it("includes a 'Select a provider…' placeholder option in the Provider select", async () => {
    renderPage({})
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))

    const providerSelect = screen.getByLabelText(
      "Provider",
    ) as HTMLSelectElement
    const optionValues = Array.from(providerSelect.options).map((o) => o.value)
    expect(optionValues).toContain("")
    const placeholderOption = Array.from(providerSelect.options).find(
      (o) => o.value === "",
    )
    expect(placeholderOption?.text).toMatch(/select a provider/i)
  })

  it("defaults providerId to the first provider when 'Add model' is clicked and fires model discovery immediately", async () => {
    const client = renderPage({
      listProviderModels: async () => ({
        ok: true,
        value: { models: [{ id: "llama3.2" }] },
      }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))

    await waitFor(() =>
      expect(client.calls.listProviderModels.length).toBeGreaterThan(0),
    )
    expect(client.calls.listProviderModels[0]).toEqual({
      providerId: "p_openai",
    })

    await waitFor(() => {
      const el = screen.getByLabelText("Model") as HTMLSelectElement
      expect(el.tagName).toBe("SELECT")
      const values = Array.from(el.options).map((o) => o.value)
      expect(values).toContain("llama3.2")
    })
  })

  it("disables 'Save model' when provider or model is missing", async () => {
    renderPage({
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))

    const saveBtn = screen.getByRole("button", { name: /save model/i })
    // Provider defaults to the first provider but model is still empty → disabled.
    expect(saveBtn).toBeDisabled()

    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })

    await waitFor(() => expect(saveBtn).not.toBeDisabled())
  })

  // ── Notification tests ────────────────────────────────────────────────────

  it("shows an error toast when adding a model fails", async () => {
    renderPage({
      addModel: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "x" },
      }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))

    await screen.findByText("Couldn't add the model")
  })

  it("shows a success toast when a model is deleted", async () => {
    renderPage({
      deleteModel: async () => ({ ok: true, value: null }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /delete/i }))

    await screen.findByText("Model deleted")
  })

  it("shows an error toast when deleting a model fails", async () => {
    renderPage({
      deleteModel: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "x" },
      }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /delete/i }))

    await screen.findByText("Couldn't delete the model")
  })

  // ── Aliases field tests ───────────────────────────────────────────────────

  it("pre-fills the aliases input with existing aliases when editing a model", async () => {
    renderPage({
      updateModel: async () => ({ ok: true, value: model }),
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini"),
    )
    expect(screen.getByLabelText("Aliases")).toHaveValue("haiku, small")
  })

  it("sends aliases as parsed array when typing aliases and saving", async () => {
    const client = renderPage({
      addModel: async (p) => ({
        ok: true,
        value: { id: "m_2", ...p } as unknown as ModelRoute,
      }),
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })
    fireEvent.change(screen.getByLabelText("Aliases"), {
      target: { value: "haiku, small" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))

    await waitFor(() => expect(client.calls.addModel.length).toBe(1))
    expect(client.calls.addModel[0]).toEqual({
      providerId: "p_openai",
      providerModel: "gpt-4o",
      aliases: ["haiku", "small"],
      attachments: { image: true, pdf: false },
      attachmentsSource: "auto",
    })
  })

  it("shows an error toast when updating a model fails", async () => {
    renderPage({
      updateModel: async () => ({
        ok: false,
        error: { kind: "handler-failed", detail: "x" },
      }),
      listProviderModels: async () => ({ ok: true, value: { models: [] } }),
    })
    await waitFor(() =>
      expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument(),
    )

    // Open the edit form for the existing model row
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini"),
    )
    // Change the model value and submit
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))

    await screen.findByText("Couldn't update the model")
  })

  it("clears providerModel when the provider changes", async () => {
    const ollamaView = {
      id: "p_ollama",
      name: "Ollama",
      sdkProvider: "ollama",
      config: {},
      secretFields: {},
      models: [],
    } as unknown as ProviderView
    const client = createFakeIpcClient({
      getModels: async () => ({ ok: true, value: [] }),
      getProviders: async () => ({ ok: true, value: [view, ollamaView] }),
      listProviderModels: async ({ providerId }) => ({
        ok: true,
        value: {
          models:
            providerId === "p_openai" ? [{ id: "gpt-4o" }] : [{ id: "llama3" }],
        },
      }),
    })
    renderWithProviders(<ModelsPage />, client)
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add model/i }),
      ).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole("button", { name: /add model/i }))

    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })
    await waitFor(() => {
      const el = screen.getByLabelText("Model")
      expect(el.tagName).toBe("SELECT")
    })
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    })
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe(
      "gpt-4o",
    )

    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_ollama" },
    })
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Model") as HTMLInputElement | HTMLSelectElement)
          .value,
      ).toBe("")
    })
  })

  // ── Attachment capabilities tests ─────────────────────────────────────────

  it("prefills capability toggles from discovery and submits them with source auto", async () => {
    const client = createFakeIpcClient({
      getModels: async () => ({ ok: true, value: [] }),
      getProviders: async () => ({ ok: true, value: [view] }),
      listProviderModels: async () => ({
        ok: true,
        value: {
          models: [
            { id: "llava:13b", attachments: { image: true, pdf: false } },
          ],
        },
      }),
      addModel: async (p) => ({
        ok: true,
        value: { id: "m_2", ...p } as unknown as ModelRoute,
      }),
    })
    renderWithProviders(
      <>
        <ModelsPage />
        <Toasts />
      </>,
      client,
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add model/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "llava:13b" },
    })
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Accepts images") as HTMLInputElement).checked,
      ).toBe(true),
    )
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))
    await waitFor(() => expect(client.calls.addModel.length).toBe(1))
    const sent = client.calls.addModel[0] as {
      attachments?: { image?: boolean; pdf?: boolean }
      attachmentsSource?: string
    }
    expect(sent.attachments).toEqual({ image: true, pdf: false })
    expect(sent.attachmentsSource).toBe("auto")
  })

  it("marks capabilities as user-set when the toggles are touched", async () => {
    const client = createFakeIpcClient({
      getModels: async () => ({ ok: true, value: [] }),
      getProviders: async () => ({ ok: true, value: [view] }),
      listProviderModels: async () => ({
        ok: true,
        value: {
          models: [
            { id: "llava:13b", attachments: { image: true, pdf: false } },
          ],
        },
      }),
      addModel: async (p) => ({
        ok: true,
        value: { id: "m_2", ...p } as unknown as ModelRoute,
      }),
    })
    renderWithProviders(
      <>
        <ModelsPage />
        <Toasts />
      </>,
      client,
    )
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /add model/i }),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: /add model/i }))
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "p_openai" },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("Model")).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "llava:13b" },
    })
    await waitFor(() =>
      expect(screen.getByLabelText("Accepts PDFs")).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByLabelText("Accepts PDFs"))
    fireEvent.click(screen.getByRole("button", { name: /save model/i }))
    await waitFor(() => expect(client.calls.addModel.length).toBe(1))
    const sent = client.calls.addModel[0] as { attachmentsSource?: string }
    expect(sent.attachmentsSource).toBe("user")
  })
})

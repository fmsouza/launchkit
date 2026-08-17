import { describe, expect, it } from "bun:test"
import type { ExtensionView } from "@spectrum/ipc"
import type { ProviderView } from "@spectrum/ipc"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { Toasts } from "../test/Toasts"
import { createFakeIpcClient } from "../test/fake-client"
import { renderWithProviders } from "../test/renderWithProviders"
import { ExtensionsPage } from "./ExtensionsPage"

const ext: ExtensionView = {
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

const openaiProvider: ProviderView = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: {},
  secretFields: { apiKey: { isSet: true } },
  models: [],
} as unknown as ProviderView

const renderPage = (stubs: Parameters<typeof createFakeIpcClient>[0]) => {
  const client = createFakeIpcClient({
    listExtensions: async () => ({ ok: true, value: [ext] }),
    getProviders: async () => ({ ok: true, value: [] }),
    ...stubs,
  })
  renderWithProviders(
    <>
      <ExtensionsPage />
      <Toasts />
    </>,
    client,
  )
  return client
}

describe("ExtensionsPage", () => {
  /** `planInstall`, the README and `docs/01-conventions/extensions.md` all say `link` is the
   * default. A GUI defaulting to `copy` silently hands the user a snapshot, and their edits
   * to the working copy then have no effect — the exact confusion link mode exists to
   * prevent. */
  it("installs in link mode by default, as the docs promise", async () => {
    const seen: unknown[] = []
    renderPage({
      installExtension: async (input: unknown) => {
        seen.push(input)
        return { ok: true, value: [ext] }
      },
    })
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /install extension/i }))
    fireEvent.change(screen.getByLabelText(/source/i), {
      target: { value: "/home/me/acme" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }))
    await waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0]).toMatchObject({ source: "/home/me/acme", mode: "link" })
  })

  it("names the referencing provider (not its opaque id) when removal is refused as in-use", async () => {
    renderPage({
      getProviders: async () => ({ ok: true, value: [openaiProvider] }),
      removeExtension: async () => ({
        ok: true,
        value: {
          refused: { kind: "in-use", id: "acme", providerIds: ["p_openai"] },
        },
      }),
    })
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }))
    await screen.findByText("Still in use by OpenAI")
    // The opaque id must not leak into the toast once a name is available.
    expect(screen.queryByText(/p_openai/)).toBeNull()
  })

  it("falls back to the raw id when the referencing provider can't be resolved to a name", async () => {
    renderPage({
      getProviders: async () => ({ ok: true, value: [] }),
      removeExtension: async () => ({
        ok: true,
        value: {
          refused: {
            kind: "in-use",
            id: "acme",
            providerIds: ["p_deleted_already"],
          },
        },
      }),
    })
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }))
    await screen.findByText("Still in use by p_deleted_already")
  })

  it("surfaces which extension failed to load and why when listExtensions errors with an id", async () => {
    renderPage({
      listExtensions: async () => ({
        ok: false,
        error: {
          kind: "handler-failed",
          detail:
            'could not list extensions: invalid extension manifest for "acme": missing name',
        },
      }),
    })
    await screen.findByText(
      /invalid extension manifest for "acme": missing name/,
    )
    expect(screen.queryByText(/undefined/)).toBeNull()
  })

  it("surfaces a load failure with no attributable id, without rendering the literal word undefined", async () => {
    renderPage({
      listExtensions: async () => ({
        ok: false,
        error: {
          kind: "handler-failed",
          detail:
            "could not list extensions: invalid extension manifest: missing name",
        },
      }),
    })
    await screen.findByText(/invalid extension manifest: missing name/)
    expect(screen.queryByText(/undefined/)).toBeNull()
  })
})

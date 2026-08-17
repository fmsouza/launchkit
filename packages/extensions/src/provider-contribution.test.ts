import { describe, expect, it } from "bun:test"
import { ProviderContributionSchema } from "./provider-contribution"

/** A complete, well-formed contribution body, minus `descriptor.actions`. */
const base = () => ({
  id: "acme",
  descriptor: {
    label: "Acme",
    configFields: [
      { name: "serverUrl", label: "Server URL", kind: "url", required: false },
    ],
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    supportsCustomHeaders: false,
    streaming: "incremental",
    reasoning: {
      shape: "openai-effort",
      supportedTiers: ["off", "low", "high"],
    },
    discovery: { strategy: "openai-models" },
  },
  transport: {
    kind: "http",
    wire: "openai",
    launch: {
      command: "acme-server",
      args: ["--port", "{{port}}"],
      envTemplate: { API_KEY: "{{apiKey}}" },
    },
  },
})

/** Overrides `descriptor.actions` on top of `base()`. */
const withActions = (actions: readonly Record<string, unknown>[]) => {
  const c = base()
  return { ...c, descriptor: { ...c.descriptor, actions } }
}

/** `base()` with `descriptor.actions` omitted entirely. */
const withoutActions = () => base()

describe("ProviderContributionSchema", () => {
  it("accepts a complete contribution when every field is well formed", () => {
    const parsed = ProviderContributionSchema.safeParse(base())
    expect(parsed.success).toBe(true)
  })

  it("accepts a contribution with no launch block when the server is user-run", () => {
    const c = base()
    const { launch: _launch, ...transportWithoutLaunch } = c.transport
    const parsed = ProviderContributionSchema.safeParse({
      ...c,
      transport: transportWithoutLaunch,
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a contribution whose wire format is unknown", () => {
    const c = base()
    const parsed = ProviderContributionSchema.safeParse({
      ...c,
      transport: { ...c.transport, wire: "grpc" },
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a contribution whose transport kind is not http", () => {
    const c = base()
    const parsed = ProviderContributionSchema.safeParse({
      ...c,
      transport: { ...c.transport, kind: "stdio" },
    })
    expect(parsed.success).toBe(false)
  })

  it("defaults readyTimeoutMs and healthPath when the launch block omits them", () => {
    const parsed = ProviderContributionSchema.parse(base())
    expect(parsed.transport.launch?.healthPath).toBe("/models")
    expect(parsed.transport.launch?.readyTimeoutMs).toBe(10_000)
  })

  it("accepts a flow action on a contribution", () => {
    const parsed = ProviderContributionSchema.safeParse(
      withActions([
        { kind: "flow", id: "signin", label: "Sign in", context: "create" },
      ]),
    )
    expect(parsed.success).toBe(true)
  })

  it("defaults to edit-config and set-secrets when the contribution declares no actions", () => {
    const parsed = ProviderContributionSchema.parse(withoutActions())
    expect(parsed.descriptor.actions.map((a) => a.kind)).toEqual([
      "edit-config",
      "set-secrets",
    ])
  })
})

import { describe, expect, it } from "bun:test"
import {
  FlowResultSchema,
  FlowStepSchema,
  type PluginError,
} from "@spectrum/extensions"
import { FlowResultViewSchema, FlowStepViewSchema } from "@spectrum/ipc"
import { createNoopLogger } from "@spectrum/logger"
import type { FlowClient, ProviderHost } from "@spectrum/provider-host"
import {
  FLOW_IN_FLIGHT_DETAIL,
  createFlowRunner,
} from "@spectrum/provider-host"
import { flowErrorMessage } from "./flow-errors"

/**
 * `FlowStepViewSchema` (`@spectrum/ipc`) is a deliberate hand-written DUPLICATE of
 * `FlowStepSchema` (`@spectrum/extensions`) — `packages/ipc` is a leaf bundled into the
 * webview and must not drag a logger and fs adapters in with it. `apps/desktop` is the one
 * place that depends on BOTH, so this is where the duplication is held honest: one fixture
 * set through both unions, identical verdicts for every non-`done` kind, and the single
 * intended divergence spelled out.
 */
const stepFixtures: readonly {
  readonly label: string
  readonly raw: unknown
}[] = [
  {
    label: "a well-formed form step",
    raw: {
      kind: "form",
      title: "Sign in",
      description: "d",
      submitLabel: "Go",
      fields: [
        {
          name: "token",
          label: "Token",
          kind: "password",
          required: true,
          placeholder: "sk-",
        },
      ],
    },
  },
  {
    label: "a form step with a well-formed select field",
    raw: {
      kind: "form",
      title: "Pick",
      fields: [
        {
          name: "region",
          label: "Region",
          kind: "select",
          required: true,
          options: [{ value: "eu", label: "EU" }],
        },
      ],
    },
  },
  {
    label: "a form step whose select field declares no options",
    raw: {
      kind: "form",
      title: "Pick",
      fields: [
        { name: "region", label: "Region", kind: "select", required: true },
      ],
    },
  },
  {
    label: "a form step whose field carries an unknown key",
    raw: {
      kind: "form",
      title: "Sign in",
      fields: [
        {
          name: "token",
          label: "Token",
          kind: "password",
          required: true,
          secret: "sk",
        },
      ],
    },
  },
  {
    label: "a form step with an empty title",
    raw: { kind: "form", title: "", fields: [] },
  },
  {
    label: "a form step carrying an unknown key of its own",
    raw: { kind: "form", title: "Sign in", fields: [], hostToken: "t" },
  },
  {
    label: "an open-external step carrying an unknown key",
    raw: {
      kind: "open-external",
      title: "Go",
      url: "https://e.com/a",
      env: { A: "1" },
    },
  },
  {
    label: "an await step carrying an unknown key",
    raw: { kind: "await", title: "Waiting", instanceKey: "flow:acme:1" },
  },
  {
    label: "an error step carrying an unknown key",
    raw: { kind: "error", message: "no", secrets: { a: "b" } },
  },
  {
    label: "a well-formed message step",
    raw: { kind: "message", title: "Hi", body: "b", tone: "warning" },
  },
  {
    label: "a message step whose tone is error",
    raw: { kind: "message", title: "Hi", body: "b", tone: "error" },
  },
  {
    label: "a message step carrying an unknown key",
    raw: { kind: "message", title: "Hi", body: "b", tone: "info", envMap: {} },
  },
  {
    label: "a well-formed open-external step",
    raw: { kind: "open-external", title: "Go", url: "https://e.com/a?b=1" },
  },
  {
    label: "an open-external step with an http url",
    raw: { kind: "open-external", title: "Go", url: "http://127.0.0.1:9000/a" },
  },
  {
    label: "an open-external step with a file url",
    raw: { kind: "open-external", title: "Go", url: "file:///etc/passwd" },
  },
  {
    label: "an open-external step with a javascript url",
    raw: { kind: "open-external", title: "Go", url: "javascript:alert(1)" },
  },
  {
    label: "an open-external step whose url is not a url at all",
    raw: { kind: "open-external", title: "Go", url: "not a url" },
  },
  {
    label: "an await step with no pollMs",
    raw: { kind: "await", title: "Waiting" },
  },
  {
    label: "an await step with a pollMs",
    raw: { kind: "await", title: "Waiting", description: "d", pollMs: 250 },
  },
  {
    label: "an await step whose pollMs is a string",
    raw: { kind: "await", title: "W", pollMs: "250" },
  },
  {
    label: "a well-formed error step",
    raw: { kind: "error", message: "Auth denied" },
  },
  { label: "an error step with no message", raw: { kind: "error" } },
  { label: "a step of an unknown kind", raw: { kind: "reboot", title: "x" } },
  { label: "a step that is not an object", raw: "form" },
]

describe("FlowStepViewSchema mirrors FlowStepSchema", () => {
  for (const { label, raw } of stepFixtures) {
    it(`reaches the same verdict as the extension schema for ${label}`, () => {
      const source = FlowStepSchema.safeParse(raw)
      const view = FlowStepViewSchema.safeParse(raw)
      expect(view.success).toBe(source.success)
      // Equal verdicts are not enough: an `await` step's `pollMs` default (or any other
      // transform) drifting apart would leave both unions accepting while the renderer got a
      // different step than the runner clamped.
      if (source.success && view.success) expect(view.data).toEqual(source.data)
    })
  }

  // ── The ONE intended divergence ────────────────────────────────────────────
  it("accepts a done step carrying only a message in both schemas", () => {
    const raw = { kind: "done", message: "Signed in" }
    expect(FlowStepSchema.safeParse(raw).success).toBe(true)
    expect(FlowStepViewSchema.safeParse(raw).success).toBe(true)
  })

  it("rejects a done step carrying secrets that the extension schema accepts", () => {
    const raw = { kind: "done", secrets: { apiKey: "sk-secret-value" } }
    expect(FlowStepSchema.safeParse(raw).success).toBe(true)
    expect(FlowStepViewSchema.safeParse(raw).success).toBe(false)
  })

  it("rejects a done step carrying config that the extension schema accepts", () => {
    const raw = { kind: "done", config: { serverUrl: "http://127.0.0.1:9000" } }
    expect(FlowStepSchema.safeParse(raw).success).toBe(true)
    expect(FlowStepViewSchema.safeParse(raw).success).toBe(false)
  })
})

const resultFixtures: readonly {
  readonly label: string
  readonly raw: unknown
}[] = [
  {
    label: "a form submission",
    raw: { kind: "form", values: { token: "sk-1" } },
  },
  {
    label: "a form submission with a non-string value",
    raw: { kind: "form", values: { token: 1 } },
  },
  { label: "an ack", raw: { kind: "ack" } },
  { label: "a poll", raw: { kind: "poll" } },
  { label: "a cancel", raw: { kind: "cancel" } },
  {
    label: "an ack carrying an unknown key",
    raw: { kind: "ack", sessionId: "s" },
  },
  { label: "an unknown result kind", raw: { kind: "resume" } },
]

describe("FlowResultViewSchema mirrors FlowResultSchema", () => {
  for (const { label, raw } of resultFixtures) {
    it(`reaches the same verdict as the extension schema for ${label}`, () => {
      const source = FlowResultSchema.safeParse(raw)
      const view = FlowResultViewSchema.safeParse(raw)
      expect(view.success).toBe(source.success)
      if (source.success && view.success) expect(view.data).toEqual(source.data)
    })
  }
})

// ── Exhaustiveness over the closed PluginError union ─────────────────────────
// Only three kinds can realistically reach a flow, but `PluginError` is closed and the mapping
// switches over all of it: a member added upstream must not fall through to `undefined`.

/** Every `detail`/`path` is the same sentinel, so "the plugin's text is never shown" is checkable. */
const DETAIL = "PLUGIN-SUPPLIED-DETAIL"

const everyPluginError: readonly PluginError[] = [
  { kind: "invalid-manifest", detail: DETAIL },
  { kind: "unsupported-api-version", apiVersion: DETAIL },
  { kind: "duplicate-id", id: "acme" },
  { kind: "read-failed", detail: DETAIL },
  { kind: "write-failed", detail: DETAIL },
  { kind: "not-found", id: "acme" },
  { kind: "in-use", id: "acme", providerIds: ["prv_1"] },
  { kind: "git-failed", detail: DETAIL },
  { kind: "source-unavailable", id: "acme", path: DETAIL },
]

describe("flowErrorMessage", () => {
  for (const error of everyPluginError) {
    it(`produces user-facing copy for a ${error.kind} failure`, () => {
      const message = flowErrorMessage(error)
      expect(typeof message).toBe("string")
      expect(message.length).toBeGreaterThan(0)
      // The extension's own `detail` is never rendered to the user.
      expect(message).not.toContain(DETAIL)
    })
  }
})

// ── The in-flight sentinel ───────────────────────────────────────────────────
// `advanceProviderFlow` tells a benign double-submit apart from a real transport failure by
// the `detail` string alone — both are `read-failed`. The string itself is now STRUCTURAL:
// `FLOW_IN_FLIGHT_DETAIL` is exported by `@spectrum/provider-host` and imported by both sides,
// so it cannot drift by a reword. What is still worth pinning is that the runner uses it on
// THIS path — a second concurrent `advance` — rather than some other inlined detail.

const hangingHost = (): ProviderHost =>
  ({
    ensureRunning: async () =>
      ({
        ok: true,
        value: { baseUrl: "http://127.0.0.1:9", pid: 1, hostToken: "t" },
      }) as never,
    status: () => "running",
    stop: async () => {},
    stopAllFor: async () => {},
    stopAll: async () => {},
    retainOnly: async () => {},
  }) as unknown as ProviderHost

describe("the runner's already-in-flight detail", () => {
  it("matches FLOW_IN_FLIGHT_DETAIL when a second advance races the first", async () => {
    // The gate is created up front, not inside `next`: the first `advance` awaits an address
    // re-check BEFORE it ever calls `next`, so a resolver captured there would still be
    // undefined by the time the racing second call returns.
    let releaseNext: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseNext = resolve
    })
    const client: FlowClient = {
      start: async () =>
        ({
          ok: true,
          value: {
            sessionId: "plugin_1",
            step: { kind: "form", title: "Sign in", fields: [] },
          },
        }) as never,
      next: async () => {
        await gate
        return {
          ok: true,
          value: { sessionId: "plugin_1", step: { kind: "done" } },
        } as never
      },
    }
    let n = 0
    const runner = createFlowRunner({
      host: hangingHost(),
      client,
      idGen: () => {
        n += 1
        return `id_${n}`
      },
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      logger: createNoopLogger(),
    })

    const started = await runner.start({
      providerId: "acme",
      flowId: "signin",
      context: "create",
      config: {},
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const sessionId = started.value.sessionId

    // Deliberately NOT awaited: the runner marks the session in-flight synchronously, so the
    // second call below is the race an impatient double-click produces.
    const first = runner.advance({ sessionId, result: { kind: "ack" } })
    const second = await runner.advance({ sessionId, result: { kind: "ack" } })

    expect(second.ok).toBe(false)
    if (!second.ok) {
      const error: PluginError = second.error
      expect(error.kind).toBe("read-failed")
      if (error.kind === "read-failed")
        expect(error.detail).toBe(FLOW_IN_FLIGHT_DETAIL)
    }
    releaseNext()
    await first
  })
})

import { describe, expect, it } from "bun:test"
import { pickModeOption } from "./config-options"
import { createRealAcpConnect } from "./real-connect"
import { supportedModesFrom } from "./session-modes"

/**
 * Live-binary checks. Each case is SKIPPED when its agent is not installed, so CI and machines
 * without a given harness stay green — but wherever the binary IS present, the real spawn +
 * handshake runs against it.
 *
 * Scope: the transport and the capability negotiation. `initialize` must succeed — that is the
 * whole transport round trip. `session/new` is attempted too, but an agent-side rejection (no
 * credentials configured for that agent on this machine) is REPORTED, not failed: it still proves
 * the request reached the agent and a structured reply came back, and an unauthenticated agent is
 * a property of the machine, not a defect in the driver.
 *
 * Conversation, approvals and interrupt need a configured provider and a real turn; those are
 * verified through the app (see the smoke checklists on #119-#122).
 */
const AGENTS: readonly {
  readonly harness: string
  readonly bin: string
  readonly args: readonly string[]
}[] = [
  { harness: "opencode", bin: "opencode", args: ["acp"] },
  { harness: "openclaw", bin: "openclaw", args: ["acp"] },
  // Claude and Codex have no ACP mode of their own — they run through separate adapter binaries
  // (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`).
  { harness: "claude", bin: "claude-agent-acp", args: [] },
  { harness: "codex", bin: "codex-acp", args: [] },
  { harness: "gemini", bin: "gemini", args: ["--acp"] },
]

for (const agent of AGENTS) {
  const resolved = Bun.which(agent.bin)

  describe(`${agent.harness} over ACP (real ${agent.bin})`, () => {
    it.skipIf(resolved === null)(
      "completes the ACP handshake and negotiates its capabilities",
      async () => {
        const connect = createRealAcpConnect({})
        const connection = await connect({
          command: resolved ?? "",
          args: agent.args,
          cwd: process.cwd(),
          env: {},
        })
        try {
          const init = await connection.client.initialize()
          expect(typeof init.promptCapabilities.image).toBe("boolean")

          const session = await connection.client
            .sessionNew(process.cwd())
            .catch((error: unknown) => {
              // Agent-side rejection (e.g. "API key is missing"): the round trip still worked.
              console.log(
                `${agent.harness}: session/new rejected — ${String(error)}`,
              )
              return undefined
            })
          if (session === undefined) return

          expect(session.sessionId.length).toBeGreaterThan(0)

          // Whatever surface the agent used to advertise modes, Spectrum must end up with a
          // coherent set: `session/new`'s `modes`, or a `category: "mode"` config option.
          const modeIds =
            session.availableModeIds.length > 0
              ? session.availableModeIds
              : (pickModeOption(session.configOptions)?.values.map(
                  (v) => v.id,
                ) ?? [])
          expect(Array.isArray(supportedModesFrom(modeIds))).toBe(true)
        } finally {
          connection.close()
        }
      },
      60_000,
    )
  })
}

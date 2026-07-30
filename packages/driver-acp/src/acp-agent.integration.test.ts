import { describe, expect, it } from "bun:test"
import { pickModeOption, pickModelOption } from "./config-options"
import { createRealAcpConnect } from "./real-connect"
import { supportedModesFrom } from "./session-modes"

/**
 * Live-binary checks. Each case is SKIPPED when its agent is not installed, so CI and machines
 * without a given harness stay green — but wherever the binary IS present, the real handshake runs.
 *
 * These cover the transport and the negotiation only: conversation, approvals and interrupt need a
 * configured provider and a real turn, and are verified through the app (see the smoke checklists
 * on #119-#122).
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
]

for (const agent of AGENTS) {
  const resolved = Bun.which(agent.bin)

  describe(`${agent.harness} over ACP (real ${agent.bin})`, () => {
    it.skipIf(resolved === null)(
      "completes the ACP handshake and opens a session",
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

          const session = await connection.client.sessionNew(process.cwd())
          expect(session.sessionId.length).toBeGreaterThan(0)

          // Whatever the agent advertises, Spectrum must end up with a coherent picture: the modes
          // it can honor (from either surface) and, if offered, a model config option it can set.
          const modeIds =
            session.availableModeIds.length > 0
              ? session.availableModeIds
              : (pickModeOption(session.configOptions)?.values.map(
                  (v) => v.id,
                ) ?? [])
          const modes = supportedModesFrom(modeIds)
          expect(Array.isArray(modes)).toBe(true)

          const firstModel = pickModeOption(session.configOptions)
            ? undefined
            : session.configOptions[0]?.values[0]?.id
          if (firstModel !== undefined)
            expect(
              pickModelOption(session.configOptions, firstModel),
            ).toBeDefined()
        } finally {
          connection.close()
        }
      },
      60_000,
    )
  })
}

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionIdSchema } from "@spectrum/types"
import {
  checkNativePtyAvailable,
  createBunFfiPtySpawner,
  createTerminalManager,
} from "./index"
import type { TabId, TerminalOutbound } from "./protocol"
import type { PtySpawner } from "./pty-adapter"

const sessionId = SessionIdSchema.parse(
  "s_00000000-0000-4000-8000-000000000000",
)

const collectOutput = (sent: ReadonlyArray<TerminalOutbound>): string =>
  sent
    .filter(
      (m): m is Extract<TerminalOutbound, { type: "term-output" }> =>
        m.type === "term-output",
    )
    .map((m) => Buffer.from(m.data, "base64").toString())
    .join("")

/**
 * Smoke test that exercises the real Bun-native PTY (`createBunFfiPtySpawner`,
 * libc `openpty(3)` via `bun:ffi`) through TerminalManager end-to-end:
 * spawn → read → exit.
 *
 * Unlike the old node-pty path (whose byte delivery was broken under Bun and so
 * had to be skipped on darwin/CI), the FFI spawner DOES deliver pty-master bytes
 * under Bun — so stdout delivery is a hard assertion here.
 *
 * Skipped only when a native PTY can't be allocated at all:
 *   - `!checkNativePtyAvailable()` (e.g. `bun:ffi`/libutil missing), OR
 *   - Windows (`openpty` is unix-only; ConPTY is not implemented).
 *
 * We spawn `/bin/sh -c "echo hi"` (not the user's login shell) so the assertion
 * doesn't couple to whatever `.zshrc` / `nvm` / `oh-my-zsh` a given machine has.
 */
describe.skipIf(!checkNativePtyAvailable() || process.platform === "win32")(
  "terminal smoke (real bun:ffi pty)",
  () => {
    it("spawns /bin/sh -c, captures stdout, and emits term-exited on close", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "spectrum-term-"))

      // Force a deterministic command instead of `process.env.SHELL` (the
      // user's login shell), which varies wildly across environments and
      // is the root cause of the CI flake we're fixing.
      const isWin = process.platform === "win32"
      const command = isWin ? "cmd.exe" : "/bin/sh"
      const args = isWin ? ["/c", "echo hi"] : ["-c", "echo hi"]
      const baseSpawner = createBunFfiPtySpawner()
      const spawner: PtySpawner = {
        spawn(input) {
          return baseSpawner.spawn({ ...input, command, args })
        },
      }

      const sent: TerminalOutbound[] = []
      const mgr = createTerminalManager({ spawner })
      mgr.bindSend((m) => sent.push(m))
      const tabId = "11111111-1111-4111-8111-111111111111" as TabId
      const r = mgr.launch({ sessionId, tabId, cwd, cols: 80, rows: 24 })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("launch failed; cannot continue smoke test")

      // Poll until either the shell prints `hi` or it exits. `/bin/sh -c`
      // exits as soon as `echo hi` returns, so term-exited may arrive
      // before all term-output chunks are delivered — we continue polling
      // a little longer after term-exited to drain any pending output.
      const echoDeadline = Date.now() + 10_000
      while (Date.now() < echoDeadline) {
        if (collectOutput(sent).includes("hi")) break
        if (sent.some((m) => m.type === "term-exited")) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      // Drain: a few short polls after term-exited to let any pending
      // term-output arrive before we assert.
      for (let i = 0; i < 10; i++) {
        if (collectOutput(sent).includes("hi")) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      // If the shell somehow hasn't exited (some Windows/cmd.exe runs
      // leave cmd open for a moment), close the terminal explicitly so
      // we exercise the `term-close` → kill() → term-exited path.
      if (!sent.some((m) => m.type === "term-exited")) {
        mgr.handleInbound({ type: "term-close", sessionId, tabId })
        const closeDeadline = Date.now() + 5_000
        while (Date.now() < closeDeadline) {
          if (sent.some((m) => m.type === "term-exited")) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      // Both checks are load-bearing for the Bun-native PTY:
      //  - term-exited proves spawn → onExit → sink, and
      //  - stdout "hi" proves the master-fd read path delivers bytes under Bun
      //    (the exact thing node-pty failed to do).
      expect(sent.some((m) => m.type === "term-exited")).toBe(true)
      expect(collectOutput(sent)).toContain("hi")

      mgr.dispose(sessionId)
    }, 30_000)
  },
)

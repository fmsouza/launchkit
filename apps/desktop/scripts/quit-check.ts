#!/usr/bin/env bun
/**
 * Scripted end-to-end quit check: does quitting Spectrum leave an orphaned plugin process?
 *
 * Plan 2's exit criterion is "Quitting Spectrum leaves no orphaned plugin processes — verify with
 * `pgrep`", and a test-suite `pgrep` does not verify it: the suite calls `stopAll()` itself and
 * never runs the quit path. This script does.
 *
 * It runs in two roles, one process each:
 * - `--child` builds a REAL `AppContext` against a throwaway `SPECTRUM_DATA_DIR`, mounts the REAL
 *   `mountQuitGate`, starts a supervised plugin through the REAL provider host, prints the plugin's
 *   pid, and idles.
 * - the parent (default) writes the plugin manifest, launches the child, waits for the pid, sends
 *   the child a SIGTERM, and then checks whether the plugin process survived.
 *
 * WHY SIGTERM: Electrobun registers its own SIGINT/SIGTERM handlers that call `Utils.quit()`
 * (`dist/api/bun/proc/native.ts`), which is the same JS entry point Cmd+Q, the app menu, the tray
 * and the last-window-closed path all funnel through. It is the quit path the gate can be driven
 * over without a human at a keyboard.
 *
 * WHAT THIS DOES NOT COVER: the native Cmd+Q path. Electrobun delivers it through a threadsafe
 * `JSCallback` (`setQuitRequestedHandler`), which returns nothing to the native side, so the
 * native quit may not observe the gate's veto at all. Verifying that needs a human at a keyboard
 * on a packaged build.
 *
 * Usage: `bun apps/desktop/scripts/quit-check.ts` — exits 0 on PASS, non-zero on FAIL.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The plugin server the manifest launches — the same fixture the integration test uses. */
const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "runtime-core",
  "src",
  "fixtures",
  "echo-openai-server.ts",
)

const PLUGIN_ID = "echo"
const PID_LINE = "PLUGIN-PID "

const manifest = (): unknown => ({
  apiVersion: "spectrum.dev/v1",
  id: PLUGIN_ID,
  name: "Echo",
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id: PLUGIN_ID,
        descriptor: {
          label: "Echo",
          reasoning: { shape: "none", supportedTiers: [] },
          discovery: { strategy: "openai-models" },
        },
        transport: {
          kind: "http",
          wire: "openai",
          launch: {
            command: process.execPath,
            args: [FIXTURE, "--port", "{{port}}"],
            envTemplate: { SPECTRUM_TOKEN: "{{hostToken}}" },
            healthPath: "/models",
            readyTimeoutMs: 20_000,
          },
        },
      },
    ],
  },
})

/** True while the process exists — `signal 0` probes without delivering anything. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── child role ────────────────────────────────────────────────────────────────

const runChild = async (): Promise<void> => {
  // Imported lazily so the parent role never constructs a database or loads Electrobun.
  const { createAppContext, realDeps } = await import("../src/composition")
  const { mountQuitGate } = await import("../src/gui/quit-gate")

  const ctx = createAppContext(realDeps)

  // Awaited: a signal landing before the listener is registered would test nothing.
  if (!process.argv.includes("--no-gate")) await mountQuitGate(ctx)

  const running = await ctx.providerHost.ensureRunning({
    instanceKey: "quit-check",
    providerId: PLUGIN_ID,
    secrets: {},
  })
  if (!running.ok) {
    process.stderr.write(
      `child: plugin never started (${running.error.kind})\n`,
    )
    process.exit(3)
  }

  process.stdout.write(`${PID_LINE}${running.value.pid}\n`)
  // Idle until the quit sequence tears this process down.
  setInterval(() => {}, 1000)
}

// ── parent role ───────────────────────────────────────────────────────────────

/** Read the child's stdout until the pid line appears (or the deadline passes). */
const readPluginPid = async (
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<number | undefined> => {
  const deadline = Date.now() + timeoutMs
  const decoder = new TextDecoder()
  // `getReader()` rather than `for await`: Bun's ReadableStream has no `[Symbol.asyncIterator]`
  // in the type surface (the same shape `smoke.ts` trips over).
  const reader = stream.getReader()
  let buffered = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return undefined
    if (value !== undefined) {
      buffered += decoder.decode(value, { stream: true })
      process.stdout.write(value)
    }
    for (const line of buffered.split("\n")) {
      const at = line.indexOf(PID_LINE)
      if (at >= 0) {
        const pid = Number(line.slice(at + PID_LINE.length).trim())
        if (Number.isInteger(pid) && pid > 0) return pid
      }
    }
    if (Date.now() > deadline) return undefined
  }
}

/** Poll until the pid is gone, or the deadline passes. Never sleeps as synchronisation. */
const waitForExit = async (
  pid: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return !alive(pid)
}

const runParent = async (): Promise<number> => {
  const dataDir = await mkdtemp(join(tmpdir(), "spectrum-quit-check-"))
  await mkdir(join(dataDir, "providers", PLUGIN_ID), { recursive: true })
  await writeFile(
    join(dataDir, "providers", PLUGIN_ID, "spectrum-extension.json"),
    JSON.stringify(manifest(), null, 2),
    "utf8",
  )
  console.log(`==> data dir: ${dataDir}`)

  const childArgs = [process.execPath, import.meta.path, "--child"]
  // Control mode: run the app WITHOUT the gate. The check must FAIL here — otherwise it is
  // proving nothing about the gate, only that the plugin happened to die with its parent.
  if (process.argv.includes("--no-gate")) childArgs.push("--no-gate")

  const child = Bun.spawn(childArgs, {
    env: { ...process.env, SPECTRUM_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "inherit",
  })

  const pluginPid =
    child.stdout === undefined
      ? undefined
      : await readPluginPid(child.stdout, 60_000)

  if (pluginPid === undefined) {
    console.error("FAIL: the child never reported a supervised plugin pid")
    child.kill("SIGKILL")
    await rm(dataDir, { recursive: true, force: true })
    return 1
  }

  if (!alive(pluginPid)) {
    console.error(
      `FAIL: plugin pid ${pluginPid} was not running before the quit`,
    )
    child.kill("SIGKILL")
    await rm(dataDir, { recursive: true, force: true })
    return 1
  }
  console.log(`==> supervised plugin running as pid ${pluginPid}`)

  console.log("==> sending SIGTERM to the app process (quit)")
  child.kill("SIGTERM")
  await child.exited
  console.log(`==> app exited with code ${child.exitCode ?? "unknown"}`)

  // The kill is asynchronous on the OS side, so poll rather than probing once.
  const gone = await waitForExit(pluginPid, 5000)

  if (!gone) {
    console.error(
      `FAIL: plugin pid ${pluginPid} survived the quit — orphaned process`,
    )
    try {
      process.kill(pluginPid, "SIGKILL")
    } catch {
      // already gone between the probe and here — nothing to reap
    }
  } else {
    console.log(`PASS: plugin pid ${pluginPid} was stopped by the quit`)
  }

  await rm(dataDir, { recursive: true, force: true })
  return gone ? 0 : 1
}

if (import.meta.main) {
  if (process.argv.includes("--child")) await runChild()
  else process.exit(await runParent())
}

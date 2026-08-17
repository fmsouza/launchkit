#!/usr/bin/env bun
import { runCli } from "@spectrum/cli"
import { createAppContext } from "@spectrum/runtime-core"
import { runCliMain } from "./cli"
import { cliDepsFrom } from "./cli-deps"

// Single-purpose CLI entry: no detectMode, no GUI. process.argv is [runtime, scriptPath, ...args];
// runCli/parseArgs treat the first token as the command, so drop the two-element prefix.
const ctx = createAppContext()
await runCliMain(process.argv.slice(2), {
  run: (argv) => runCli(cliDepsFrom(ctx))(argv),
  // `runCliMain` awaits `shutdown` before calling this — `process.exit` never returns, so a
  // supervised plugin process not stopped by then is orphaned.
  exit: (code) => process.exit(code),
  errOut: (line) => process.stderr.write(`${line}\n`),
  shutdown: () => ctx.shutdown(),
})

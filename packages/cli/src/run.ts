import { createNoopLogger } from "@spectrum/logger"
import { type Result, err } from "@spectrum/utils"
import type { CliDeps } from "./deps"
import type { CliError } from "./errors"
import { launchCommand } from "./launch-command"
import { list } from "./list"
import { add, remove } from "./mutate-command"
import { parseArgs } from "./parse-args"
import { pluginCommand } from "./plugin-command"

const KNOWN_COMMANDS = ["launch", "list", "add", "remove", "plugin"] as const

const usage = (): Result<void, CliError> =>
  err({
    kind: "usage",
    detail: `expected one of: ${KNOWN_COMMANDS.join(", ")}`,
  })

/**
 * Build the CLI entry point over injected deps. Returns a function that parses argv
 * and dispatches on the command, returning a typed `Result` (never throwing).
 */
export const runCli =
  (deps: CliDeps) =>
  async (argv: readonly string[]): Promise<Result<void, CliError>> => {
    const logger = deps.logger ?? createNoopLogger()
    const { command, rest, flags } = parseArgs(argv)

    const result = await dispatch(deps, command, rest, flags)

    // Observation only: log on failure (kind only — never argv, which may carry a
    // secret value on `add`). The Result and the user-facing stderr line are unchanged.
    if (!result.ok)
      logger.error("cli command failed", { kind: result.error.kind })

    return result
  }

const dispatch = (
  deps: CliDeps,
  command: string,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  if (command === "") return Promise.resolve(usage())

  switch (command) {
    case "launch":
      return runLaunch(deps, rest, flags)
    case "list":
      return runList(deps, rest)
    case "add":
      return runAdd(deps, rest, flags)
    case "remove":
      return runRemove(deps, rest)
    case "plugin":
      return runPlugin(deps, rest, flags)
    default:
      return Promise.resolve(err({ kind: "unknown-command", command }))
  }
}

// --- command dispatch helpers --------------------------------------------------------
// Thin wrappers that forward to each command's implementation; nothing throws (Result-typed).

const runLaunch = (
  deps: CliDeps,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => launchCommand(deps, rest, flags)

const runList = (
  deps: CliDeps,
  rest: readonly string[],
): Promise<Result<void, CliError>> => list(deps, rest)

const runAdd = (
  deps: CliDeps,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => add(deps, rest, flags)

const runRemove = (
  deps: CliDeps,
  rest: readonly string[],
): Promise<Result<void, CliError>> => remove(deps, rest)

const runPlugin = (
  deps: CliDeps,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => pluginCommand(deps, rest, flags)

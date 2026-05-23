import { type Result, err } from "@launchkit/utils"
import type { CliDeps } from "./deps"
import type { CliError } from "./errors"
import { launchCommand } from "./launch-command"
import { list } from "./list"
import { add, remove } from "./mutate-command"
import { parseArgs } from "./parse-args"

const KNOWN_COMMANDS = ["launch", "list", "add", "remove"] as const

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
    const { command, rest, flags } = parseArgs(argv)

    if (command === "") return usage()

    switch (command) {
      case "launch":
        return runLaunch(deps, rest, flags)
      case "list":
        return runList(deps, rest)
      case "add":
        return runAdd(deps, rest, flags)
      case "remove":
        return runRemove(deps, rest)
      default:
        return err({ kind: "unknown-command", command })
    }
  }

// --- command stubs (replaced in cli-03/04/05) ----------------------------------------
// These return a `usage` Result so dispatch is testable now and nothing throws.

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

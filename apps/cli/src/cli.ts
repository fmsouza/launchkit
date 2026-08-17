#!/usr/bin/env bun
import type { CliError } from "@spectrum/cli"
import type { Result } from "@spectrum/utils"

/**
 * Render a `CliError` as a single human-readable line (no trailing newline — the caller adds it).
 * Exhaustive over the union so a new `CliError` variant becomes a compile error here.
 */
export const formatCliError = (error: CliError): string => {
  switch (error.kind) {
    case "unknown-command":
      return `spectrum: unknown command "${error.command}"`
    case "usage":
      return `spectrum: ${error.detail}`
    case "failed":
      return `spectrum: ${error.detail}`
  }
}

/** Seams so the entry is unit-testable without real subsystems or a real process. */
export type CliMainDeps = {
  readonly run: (argv: readonly string[]) => Promise<Result<void, CliError>>
  readonly exit: (code: number) => void
  /** Write one diagnostic line to stderr. Receives the line WITHOUT a trailing newline. */
  readonly errOut: (line: string) => void
  /**
   * Stop everything the app supervises — today, the plugin provider child processes the
   * provider host spawned. Awaited on BOTH the success and the failure path: `process.exit`
   * is immediate, so a child not killed before it becomes an orphan that outlives the CLI.
   */
  readonly shutdown: () => Promise<void>
}

/**
 * Drain supervised state before exit. A failed shutdown is REPORTED, never swallowed — but it
 * must not prevent the exit either, or a broken teardown would hang the CLI forever.
 */
const drain = async (deps: CliMainDeps): Promise<void> => {
  try {
    await deps.shutdown()
  } catch (cause) {
    deps.errOut(
      `spectrum: shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/** Run the CLI, map the Result to an exit code + a human-readable stderr line. */
export const runCliMain = async (
  argv: readonly string[],
  deps: CliMainDeps,
): Promise<void> => {
  const result = await deps.run(argv)
  if (!result.ok) deps.errOut(formatCliError(result.error))
  await drain(deps)
  deps.exit(result.ok ? 0 : 1)
}

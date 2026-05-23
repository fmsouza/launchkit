import { type Result, ok, err } from "@launchkit/utils"
import type { HarnessError } from "./errors"

/**
 * Reads + JSON-parses each `*.json` file in the user harness directory.
 * Returns the raw parsed values (still `unknown`); validation happens in the registry.
 */
export interface HarnessFileSource {
  listDefinitions(): Promise<Result<readonly unknown[], HarnessError>>
}

/** In-memory fake: returns the given defs, or a preset error to exercise read failures. */
export const createInMemoryHarnessFileSource = (
  defs: readonly unknown[],
  failure?: HarnessError,
): HarnessFileSource => ({
  listDefinitions: async (): Promise<Result<readonly unknown[], HarnessError>> =>
    failure === undefined ? ok(defs) : err(failure),
})

import type { Result } from "@launchkit/utils"
import type { SecretError } from "./backend"

/**
 * The process-spawn effect for the real keychain backend.
 * `command` + `args` are passed as an argument array — never joined into a shell string.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[]): Promise<Result<{ stdout: string }, SecretError>>
}

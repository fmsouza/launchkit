import { type Result, ok, err, isOk, redactSecrets } from "@launchkit/utils"
import type { KeychainBackend, SecretError } from "./backend"
import type { ProcessRunner } from "./process-runner"

const SERVICE = "launchkit"

/** Scrub the live secret out of any backend-failed detail before it propagates. */
const redactError = (error: SecretError, secrets: readonly string[]): SecretError =>
  error.kind === "backend-failed"
    ? { kind: "backend-failed", detail: redactSecrets(error.detail, secrets) }
    : error

export const createMacosSecurityBackend = (deps: {
  readonly runner: ProcessRunner
}): KeychainBackend => {
  const { runner } = deps
  return {
    add: async (account, secret) => {
      const result = await runner.run("security", [
        "add-generic-password", "-a", account, "-s", SERVICE, "-w", secret, "-U",
      ])
      return isOk(result) ? ok(undefined) : err(redactError(result.error, [secret]))
    },
    find: async (account) => {
      const result = await runner.run("security", [
        "find-generic-password", "-a", account, "-s", SERVICE, "-w",
      ])
      if (!isOk(result)) return err(redactError(result.error, []))
      return ok(result.value.stdout.replace(/\n$/, ""))
    },
    remove: async (account) => {
      const result = await runner.run("security", [
        "delete-generic-password", "-a", account, "-s", SERVICE,
      ])
      return isOk(result) ? ok(undefined) : err(redactError(result.error, []))
    },
  }
}

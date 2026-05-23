import {
  type AliasName,
  AliasNameSchema,
  type HarnessDefinition,
} from "@launchkit/types"
import { type Result, err, isErr, ok } from "@launchkit/utils"
import type { CliDeps } from "./deps"
import type { CliError } from "./errors"

/** Resolve the alias: the `--model` flag if a string, else the harness's defaultAlias. */
const resolveAlias = (
  harness: HarnessDefinition,
  flags: Readonly<Record<string, string | boolean>>,
): AliasName => {
  const flag = flags.model
  return typeof flag === "string"
    ? AliasNameSchema.parse(flag)
    : harness.defaultAlias
}

/**
 * `launch <harnessId> [--model <alias>]`.
 *
 * Loads config, finds the harness, resolves the alias, ensures a proxy is up (reusing a
 * running one, else starting an ephemeral one with a freshly generated per-run key), then
 * launches the harness and records a session. SECURITY: the generated proxy key flows only
 * into `deps.launch(...)` (which the harness launcher places in the child env) — it is
 * never passed to `deps.out.write`.
 */
export const launchCommand = async (
  deps: CliDeps,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  const harnessId = rest[0]
  if (harnessId === undefined) {
    return err({
      kind: "usage",
      detail: "launch <harnessId> [--model <alias>]",
    })
  }

  const loaded = await deps.config.load()
  if (isErr(loaded))
    return err({ kind: "failed", detail: "could not load config" })
  const { settings } = loaded.value

  const listed = await deps.registry.list()
  if (isErr(listed))
    return err({ kind: "failed", detail: "could not list harnesses" })

  const harness = listed.value.find((h) => h.id === harnessId)
  if (harness === undefined) {
    return err({ kind: "usage", detail: `unknown harness: ${harnessId}` })
  }

  const alias = resolveAlias(harness, flags)
  const proxyUrl = `http://${settings.proxyHost}:${settings.proxyPort}`

  // Ensure a proxy is up. Reuse a running one; otherwise start an ephemeral one.
  const proxyKey = deps.genProxyKey()
  const alreadyRunning = await deps.proxy.isRunning(proxyUrl)
  if (!alreadyRunning) {
    deps.proxy.start({
      host: settings.proxyHost,
      port: settings.proxyPort,
      proxyKey,
      config: loaded.value,
    })
  }
  // When reusing a running proxy we cannot know its key; the launcher still needs *a*
  // value, so the freshly generated one is handed off either way. (It is never printed.)

  const launched = deps.launch({ harness, proxyUrl, proxyKey, model: alias })
  if (isErr(launched))
    return err({ kind: "failed", detail: "failed to launch harness" })

  const session = deps.sessions.create({ harnessId: harness.id, alias })
  if (isErr(session))
    return err({ kind: "failed", detail: "failed to record session" })

  deps.out.write(
    `launched ${harness.id} (pid ${launched.value.pid}, session ${session.value.id})`,
  )
  return ok(undefined)
}

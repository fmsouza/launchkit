import type {
  InstallInput,
  InstalledExtension,
  PluginError,
} from "@spectrum/extensions"
import { type PluginId, PluginIdSchema } from "@spectrum/types"
import { type Result, err, isErr, ok } from "@spectrum/utils"
import type { CliDeps } from "./deps"
import type { CliError } from "./errors"

const PLUGIN_TARGETS = [
  "list",
  "install",
  "enable",
  "disable",
  "update",
  "remove",
] as const

/**
 * Human-readable detail for a `PluginError`, exhaustive over the closed union
 * (`@spectrum/extensions`). Mirrors `describePluginError` in the GUI's IPC handlers
 * (`apps/desktop/src/gui/ipc/handlers.ts`) — same wording, different surface. Never a
 * secret — `PluginError` never carries one.
 */
const describePluginError = (e: PluginError): string => {
  switch (e.kind) {
    case "invalid-manifest":
      return e.id === undefined
        ? `invalid extension manifest: ${e.detail}`
        : `invalid extension manifest for "${e.id}": ${e.detail}`
    case "unsupported-api-version":
      return e.id === undefined
        ? `extension needs a newer version of Spectrum (apiVersion "${e.apiVersion}")`
        : `extension "${e.id}" needs a newer version of Spectrum (apiVersion "${e.apiVersion}")`
    case "duplicate-id":
      return `duplicate extension id "${e.id}"`
    case "read-failed":
      return `could not read: ${e.detail}`
    case "write-failed":
      return `could not write: ${e.detail}`
    case "not-found":
      return `extension not found: ${e.id}`
    case "in-use":
      return `extension "${e.id}" is in use by ${e.providerIds.join(", ")}`
    case "git-failed":
      return `git failed: ${e.detail}`
    case "source-unavailable":
      return `source unavailable: ${e.path}`
  }
}

/** Parse a raw argv token as a `PluginId` — the same brand `extensionDir` relies on for its
 * path-traversal guard. Anything that doesn't match the slug shape is a `usage` error,
 * refused before it ever reaches `CliDeps.extensions`. */
const parsePluginId = (raw: string | undefined): Result<PluginId, CliError> => {
  if (raw === undefined)
    return err({ kind: "usage", detail: "expected a plugin id" })
  const parsed = PluginIdSchema.safeParse(raw)
  if (!parsed.success)
    return err({ kind: "usage", detail: `invalid plugin id: ${raw}` })
  return ok(parsed.data)
}

/**
 * `install`/`update` disclosure — spec §3: this IS the trust decision, so it prints exactly
 * what will happen and nothing is hidden behind a confirmation prompt. Prints the resolved
 * commit (git) or the linked/copied path, the UNRENDERED spawn command + args (never
 * rendered — a rendered arg can carry a resolved secret), and the declared secret field
 * NAMES only. Never prints an env map, a host token, or an instance key — `envTemplate`
 * is deliberately never touched here.
 */
const discloseInstall = (
  deps: CliDeps,
  installed: InstalledExtension,
): void => {
  const { manifest, install } = installed
  const origin =
    install.source.kind === "git"
      ? `commit ${install.source.commit}`
      : install.source.kind === "path"
        ? install.source.linked
          ? `linked path ${install.source.path}`
          : `path ${install.source.path}`
        : "a hand-placed local directory"
  deps.out.write(
    `installed ${manifest.id} (${manifest.version}) from ${origin}`,
  )

  for (const contribution of manifest.contributes.providers) {
    const launch = contribution.transport.launch
    if (launch !== undefined) {
      deps.out.write(`  will spawn: ${launch.command} ${launch.args.join(" ")}`)
    }
    const secretNames = contribution.descriptor.secretFields.map((f) => f.name)
    if (secretNames.length > 0) {
      deps.out.write(`  declared secrets: ${secretNames.join(", ")}`)
    }
    if (contribution.descriptor.actions?.some((a) => a.kind === "flow")) {
      deps.out.write(
        `  ${contribution.id}: at least one setup action is only available in the GUI`,
      )
    }
  }
}

const runList = async (deps: CliDeps): Promise<Result<void, CliError>> => {
  const listed = await deps.extensionRegistry.list()
  if (isErr(listed))
    return err({
      kind: "failed",
      detail: `could not list extensions: ${describePluginError(listed.error)}`,
    })

  const loaded = await deps.config.load()
  if (isErr(loaded))
    return err({ kind: "failed", detail: "could not load config" })
  const installs = loaded.value.providerPlugins

  for (const extension of listed.value) {
    const install = installs.find(
      (p) => String(p.id) === String(extension.manifest.id),
    )
    const enabled = install?.enabled ?? false
    deps.out.write(
      `${extension.manifest.id}\t${extension.manifest.name}\t${enabled ? "enabled" : "disabled"}`,
    )
    for (const contribution of extension.manifest.contributes.providers) {
      if (contribution.descriptor.actions?.some((a) => a.kind === "flow")) {
        deps.out.write(
          `  ${contribution.id}: at least one setup action is only available in the GUI`,
        )
      }
    }
  }
  return ok(undefined)
}

const runInstall = async (
  deps: CliDeps,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  const source = rest[0]
  if (source === undefined)
    return err({ kind: "usage", detail: "plugin install <source>" })

  const ref = typeof flags.ref === "string" ? flags.ref : undefined
  const id = typeof flags.id === "string" ? flags.id : undefined
  const mode = flags.copy === true ? ("copy" as const) : undefined

  const input: InstallInput = {
    source,
    ...(ref === undefined ? {} : { ref }),
    ...(id === undefined ? {} : { id }),
    ...(mode === undefined ? {} : { mode }),
  }

  const installed = await deps.extensions.install(input)
  if (isErr(installed))
    return err({
      kind: "failed",
      detail: `could not install extension: ${describePluginError(installed.error)}`,
    })

  discloseInstall(deps, installed.value)
  return ok(undefined)
}

const runSetEnabled = async (
  deps: CliDeps,
  rest: readonly string[],
  enabled: boolean,
): Promise<Result<void, CliError>> => {
  const idResult = parsePluginId(rest[0])
  if (isErr(idResult)) return idResult

  const result = await deps.extensions.setEnabled(idResult.value, enabled)
  if (isErr(result))
    return err({
      kind: "failed",
      detail: `could not update extension: ${describePluginError(result.error)}`,
    })
  return ok(undefined)
}

const runUpdate = async (
  deps: CliDeps,
  rest: readonly string[],
): Promise<Result<void, CliError>> => {
  const idResult = parsePluginId(rest[0])
  if (isErr(idResult)) return idResult

  const updated = await deps.extensions.update(idResult.value)
  if (isErr(updated))
    return err({
      kind: "failed",
      detail: `could not update extension: ${describePluginError(updated.error)}`,
    })

  discloseInstall(deps, updated.value)
  return ok(undefined)
}

const runRemove = async (
  deps: CliDeps,
  rest: readonly string[],
): Promise<Result<void, CliError>> => {
  const idResult = parsePluginId(rest[0])
  if (isErr(idResult)) return idResult

  const result = await deps.extensions.remove(idResult.value)
  if (isErr(result)) {
    // `in-use` is reported here (not just via `CliError.detail`, which only ever reaches
    // stderr) so `plugin remove` can name the referencing providers on the CLI's normal
    // output surface.
    deps.out.write(describePluginError(result.error))
    return err({
      kind: "failed",
      detail: `could not remove extension: ${describePluginError(result.error)}`,
    })
  }
  return ok(undefined)
}

/** `plugin list | install | enable | disable | update | remove`. */
export const pluginCommand = async (
  deps: CliDeps,
  rest: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): Promise<Result<void, CliError>> => {
  const target = rest[0]
  const tail = rest.slice(1)
  switch (target) {
    case "list":
      return runList(deps)
    case "install":
      return runInstall(deps, tail, flags)
    case "enable":
      return runSetEnabled(deps, tail, true)
    case "disable":
      return runSetEnabled(deps, tail, false)
    case "update":
      return runUpdate(deps, tail)
    case "remove":
      return runRemove(deps, tail)
    default:
      return err({
        kind: "usage",
        detail: `plugin <${PLUGIN_TARGETS.join("|")}>`,
      })
  }
}

import type { PluginInstall } from "@spectrum/config"
import { type Logger, createNoopLogger } from "@spectrum/logger"
import type { PluginId } from "@spectrum/types"
import { type Result, err, isErr, ok } from "@spectrum/utils"
import { validateContributionTemplates } from "./env-template"
import type { PluginError } from "./errors"
import type { ExtensionFileSource } from "./file-source"
import type { DirCopier, GitClient } from "./git"
import type { ExtensionManifest, ParsedManifest } from "./manifest"
import { parseManifest } from "./manifest"
import type { InstallMode, InstallPlan } from "./plan-install"
import { planInstall } from "./plan-install"
import { redactUrlCredentials } from "./redact"

export type InstalledExtension = {
  readonly manifest: ExtensionManifest
  readonly install: PluginInstall
  readonly ignoredContributions: readonly string[]
}

export type InstallInput = {
  readonly source: string
  readonly ref?: string
  readonly id?: string
  readonly mode?: InstallMode
}

export interface ExtensionInstaller {
  install(input: InstallInput): Promise<Result<InstalledExtension, PluginError>>
  update(
    id: PluginId,
    install: PluginInstall,
  ): Promise<Result<InstalledExtension, PluginError>>
  remove(
    id: PluginId,
    install: PluginInstall,
    referencingProviderIds: readonly string[],
  ): Promise<Result<void, PluginError>>
}

const sourceKindOf = (install: PluginInstall): string => install.source.kind

/**
 * Structural narrow, not a cast: `planInstall` guarantees `writeDir` is set for a `git` plan
 * and a `path`+`copy` plan, and unset for a `path`+`link` plan, but nothing in the `InstallPlan`
 * TYPE encodes that correlation. A `p.writeDir as string` would compile even if a future
 * `planInstall` change broke the guarantee, turning it into a runtime `git.clone(url,
 * undefined)`. This guard instead turns that "shouldn't happen" into a typed `Result`.
 */
const hasWriteDir = (
  plan: InstallPlan,
): plan is InstallPlan & { readonly writeDir: string } =>
  plan.writeDir !== undefined

const noWriteDirError = (plan: InstallPlan): PluginError => ({
  kind: "write-failed",
  detail: `internal: planInstall produced no write directory for a ${plan.source.kind} install of "${plan.id}"`,
})

/** Reads every already-installed extension's manifest and collects the provider-contribution
 * ids it declares. Entries the file source could not read (a dead linked source) or whose
 * manifest fails to parse are skipped rather than failing the whole check — a broken
 * neighbour must not block an unrelated install. `excludeId` skips the entry being
 * (re)validated itself, so an update never collides with its own prior contributions. */
const collectClaimedContributionIds = async (
  fileSource: ExtensionFileSource,
  excludeId: string,
): Promise<Result<ReadonlySet<string>, PluginError>> => {
  const listed = await fileSource.listExtensions()
  if (isErr(listed)) return listed

  const claimed = new Set<string>()
  for (const entry of listed.value) {
    if ("error" in entry) continue
    if (entry.id === excludeId) continue
    const parsed = parseManifest(entry.raw)
    if (isErr(parsed)) continue
    for (const contribution of parsed.value.manifest.contributes.providers) {
      claimed.add(String(contribution.id))
    }
  }
  return ok(claimed)
}

/**
 * Rules 3-5: read the manifest from `dir`, validate its shape and api version, confirm its
 * declared id matches `id`, validate every provider contribution's launch templates, and
 * confirm none of its contributed provider ids collide with an already-installed extension.
 */
const validateManifest = (deps: {
  readonly readManifest: (dir: string) => Promise<Result<unknown, PluginError>>
  readonly fileSource: ExtensionFileSource
}) => {
  return async (
    id: PluginId,
    dir: string,
  ): Promise<Result<ParsedManifest, PluginError>> => {
    const raw = await deps.readManifest(dir)
    if (isErr(raw)) return raw

    const parsed = parseManifest(raw.value)
    if (isErr(parsed)) return parsed
    const { manifest, ignoredContributions } = parsed.value

    if (manifest.id !== String(id)) {
      return err({
        kind: "invalid-manifest",
        detail: `manifest id "${manifest.id}" does not match install id "${id}"`,
      })
    }

    for (const contribution of manifest.contributes.providers) {
      const templates = validateContributionTemplates(contribution)
      if (isErr(templates)) return templates
    }

    const claimed = await collectClaimedContributionIds(
      deps.fileSource,
      String(id),
    )
    if (isErr(claimed)) return claimed
    // Seed with the incoming manifest's OWN ids as they're walked, not just the other
    // extensions' claimed set. `ExtensionManifestSchema` already refuses a manifest that
    // collides with itself (defense #1, and the one that also covers hand-placed and
    // linked directories, which never reach this installer at all) — this is defense #2,
    // so the installer's own pre-install check reports the collision in its own error
    // shape rather than relying solely on the schema layer.
    const seenInThisManifest = new Set<string>()
    for (const contribution of manifest.contributes.providers) {
      const contributionId = String(contribution.id)
      if (
        claimed.value.has(contributionId) ||
        seenInThisManifest.has(contributionId)
      ) {
        return err({ kind: "duplicate-id", id: contributionId })
      }
      seenInThisManifest.add(contributionId)
    }

    return ok({ manifest, ignoredContributions })
  }
}

export const createExtensionInstaller = (deps: {
  readonly git: GitClient
  readonly copier: DirCopier
  readonly fileSource: ExtensionFileSource
  readonly readManifest: (dir: string) => Promise<Result<unknown, PluginError>>
  readonly pluginRoot: string
  readonly existingInstalls: () => readonly PluginInstall[]
  readonly logger?: Logger
}): ExtensionInstaller => {
  const logger = deps.logger ?? createNoopLogger()
  const validate = validateManifest({
    readManifest: deps.readManifest,
    fileSource: deps.fileSource,
  })

  /** Rule 6: any failure after something was written removes exactly what was written. A
   * linked install (`plan.writeDir === undefined`) wrote nothing under the plugin root, so
   * it must not even call `removeExtension` — that is the invariant that protects a user's
   * own working directory from deletion. */
  const cleanupAfterFailure = async (plan: InstallPlan): Promise<void> => {
    if (plan.writeDir === undefined) return
    await deps.fileSource.removeExtension(String(plan.id))
  }

  const install = async (
    input: InstallInput,
  ): Promise<Result<InstalledExtension, PluginError>> => {
    const plan = planInstall({
      source: input.source,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      pluginRoot: deps.pluginRoot,
      existingIds: deps.existingInstalls().map((i) => String(i.id)),
    })
    if (isErr(plan)) {
      logger.error("extension install failed", {
        source: redactUrlCredentials(input.source),
        kind: plan.error.kind,
      })
      return plan
    }
    const p = plan.value

    let commit: string | undefined
    if (p.source.kind === "git") {
      if (!hasWriteDir(p)) {
        const error = noWriteDirError(p)
        logger.error("extension install failed", {
          id: String(p.id),
          kind: error.kind,
        })
        return err(error)
      }
      const cloned = await deps.git.clone(
        p.source.url,
        p.writeDir,
        p.source.ref,
      )
      if (isErr(cloned)) {
        logger.error("extension install failed", {
          id: String(p.id),
          kind: cloned.error.kind,
        })
        return cloned
      }
      const revved = await deps.git.revParse(p.writeDir)
      if (isErr(revved)) {
        await cleanupAfterFailure(p)
        logger.error("extension install failed", {
          id: String(p.id),
          kind: revved.error.kind,
        })
        return revved
      }
      commit = revved.value
    } else if (p.source.kind === "path" && !p.source.linked) {
      if (!hasWriteDir(p)) {
        const error = noWriteDirError(p)
        logger.error("extension install failed", {
          id: String(p.id),
          kind: error.kind,
        })
        return err(error)
      }
      const exists = await deps.copier.exists(p.source.path)
      if (!exists) {
        const error: PluginError = {
          kind: "source-unavailable",
          id: String(p.id),
          path: p.source.path,
        }
        logger.error("extension install failed", {
          id: String(p.id),
          kind: error.kind,
        })
        return err(error)
      }
      // A hand-placed extension at the destination has no config record, so it is not
      // among `existingInstalls()` and `planInstall`'s own duplicate-id check (which only
      // looks at existingIds) never sees the id as taken. Without this check, `copy` would
      // overwrite that directory and, on any later validation failure, `cleanupAfterFailure`
      // would delete a directory this install never created.
      const occupied = await deps.copier.exists(p.writeDir)
      if (occupied) {
        const error: PluginError = { kind: "duplicate-id", id: String(p.id) }
        logger.error("extension install failed", {
          id: String(p.id),
          kind: error.kind,
        })
        return err(error)
      }
      const copied = await deps.copier.copy(p.source.path, p.writeDir)
      if (isErr(copied)) {
        // The destination-occupied check above means a copy failure here did not
        // overwrite a pre-existing directory, so cleaning up whatever the failed copy
        // partially wrote is safe.
        await cleanupAfterFailure(p)
        logger.error("extension install failed", {
          id: String(p.id),
          kind: copied.error.kind,
        })
        return copied
      }
    } else if (p.source.kind === "path" && p.source.linked) {
      const exists = await deps.copier.exists(p.source.path)
      if (!exists) {
        const error: PluginError = {
          kind: "source-unavailable",
          id: String(p.id),
          path: p.source.path,
        }
        logger.error("extension install failed", {
          id: String(p.id),
          kind: error.kind,
        })
        return err(error)
      }
    }

    const validated = await validate(p.id, p.readDir)
    if (isErr(validated)) {
      await cleanupAfterFailure(p)
      logger.error("extension install failed", {
        id: String(p.id),
        kind: validated.error.kind,
      })
      return validated
    }

    let pluginInstall: PluginInstall
    if (p.source.kind === "git") {
      if (commit === undefined) {
        // Reachable, not just defensive: `GitClient` is an injected adapter (real or
        // fake), not in-package logic, so its `Result<string, ...>` contract is trusted
        // rather than enforced by the type system here. A misbehaving adapter whose
        // `revParse` resolves `ok(undefined)` despite the return type would otherwise
        // produce a `PluginInstall` with an undefined commit; this guard turns that into
        // a typed `write-failed` Result instead.
        const error: PluginError = {
          kind: "write-failed",
          detail: `internal: git install of "${p.id}" resolved no commit`,
        }
        logger.error("extension install failed", {
          id: String(p.id),
          kind: error.kind,
        })
        return err(error)
      }
      pluginInstall = {
        id: p.id,
        source: { kind: "git", url: p.source.url, ref: p.source.ref, commit },
        enabled: true,
      }
    } else {
      pluginInstall = {
        id: p.id,
        source: {
          kind: "path",
          path: p.source.path,
          linked: p.source.linked,
        },
        enabled: true,
      }
    }

    logger.info("extension installed", {
      id: String(p.id),
      sourceKind: p.source.kind,
      ...(commit === undefined ? {} : { commit }),
    })

    return ok({
      manifest: validated.value.manifest,
      install: pluginInstall,
      ignoredContributions: validated.value.ignoredContributions,
    })
  }

  const update = async (
    id: PluginId,
    current: PluginInstall,
  ): Promise<Result<InstalledExtension, PluginError>> => {
    if (String(current.id) !== String(id)) {
      const error: PluginError = {
        kind: "invalid-manifest",
        detail: `install record id "${current.id}" does not match requested id "${id}"`,
      }
      logger.error("extension update failed", {
        id: String(id),
        kind: error.kind,
      })
      return err(error)
    }

    if (current.source.kind !== "git") {
      const detail =
        current.source.kind === "local"
          ? `cannot update a local hand-placed extension: ${id}`
          : current.source.linked
            ? `cannot update a linked extension, there is nothing to fetch: ${id}`
            : `cannot update a snapshotted copy in place, reinstall with --copy instead: ${id}`
      const error: PluginError = { kind: "invalid-manifest", detail }
      logger.error("extension update failed", {
        id: String(id),
        kind: error.kind,
      })
      return err(error)
    }

    // `extensionDir` is the file source's own definition of an installed extension's
    // directory (real adapter: `linkMap[id] ?? join(root, id)`) — re-deriving `pluginRoot/id`
    // here would be a second, driftable definition of the same layout. Only reached for
    // `git` installs, which are never linked, so this always resolves to `root/id`.
    const dir = deps.fileSource.extensionDir(id)

    const fetched = await deps.git.fetchCheckout(dir, current.source.ref)
    if (isErr(fetched)) {
      logger.error("extension update failed", {
        id: String(id),
        kind: fetched.error.kind,
      })
      return fetched
    }
    const revved = await deps.git.revParse(dir)
    if (isErr(revved)) {
      logger.error("extension update failed", {
        id: String(id),
        kind: revved.error.kind,
      })
      return revved
    }

    const validated = await validate(id, dir)
    if (isErr(validated)) {
      logger.error("extension update failed", {
        id: String(id),
        kind: validated.error.kind,
      })
      return validated
    }

    const updatedInstall: PluginInstall = {
      ...current,
      source: { ...current.source, commit: revved.value },
    }

    logger.info("extension updated", {
      id: String(id),
      sourceKind: updatedInstall.source.kind,
      commit: revved.value,
    })

    return ok({
      manifest: validated.value.manifest,
      install: updatedInstall,
      ignoredContributions: validated.value.ignoredContributions,
    })
  }

  const remove = async (
    id: PluginId,
    current: PluginInstall,
    referencingProviderIds: readonly string[],
  ): Promise<Result<void, PluginError>> => {
    if (referencingProviderIds.length > 0) {
      const error: PluginError = {
        kind: "in-use",
        id: String(id),
        providerIds: referencingProviderIds,
      }
      logger.error("extension remove failed", {
        id: String(id),
        kind: error.kind,
      })
      return err(error)
    }

    // Only a `git` install or a `copy`-mode `path` install ever wrote into the plugin
    // root. A `linked` path install and a `local` hand-placed directory did not, so there
    // is nothing under the root to remove — and removing must not be attempted, because
    // that is exactly the invariant that keeps uninstall from ever touching a user's own
    // working directory.
    const wroteIntoRoot =
      current.source.kind === "git" ||
      (current.source.kind === "path" && !current.source.linked)

    if (wroteIntoRoot) {
      const removed = await deps.fileSource.removeExtension(String(id))
      if (isErr(removed)) {
        logger.error("extension remove failed", {
          id: String(id),
          kind: removed.error.kind,
        })
        return removed
      }
    }

    logger.info("extension removed", {
      id: String(id),
      sourceKind: sourceKindOf(current),
    })
    return ok(undefined)
  }

  return { install, update, remove }
}

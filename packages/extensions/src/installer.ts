import { join } from "node:path"
import type { PluginInstall } from "@spectrum/config"
import { type Logger, createNoopLogger } from "@spectrum/logger"
import type { PluginId } from "@spectrum/types"
import { type Result, err, isErr, ok } from "@spectrum/utils"
import { validateContributionTemplates } from "./env-template"
import type { PluginError } from "./errors"
import type { ExtensionFileSource } from "./file-source"
import { redactUrlCredentials } from "./git"
import type { DirCopier, GitClient } from "./git"
import type { ExtensionManifest, ParsedManifest } from "./manifest"
import { parseManifest } from "./manifest"
import type { InstallMode, InstallPlan } from "./plan-install"
import { planInstall } from "./plan-install"

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
    for (const contribution of manifest.contributes.providers) {
      const contributionId = String(contribution.id)
      if (claimed.value.has(contributionId)) {
        return err({ kind: "duplicate-id", id: contributionId })
      }
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
      const writeDir = p.writeDir as string
      const cloned = await deps.git.clone(p.source.url, writeDir, p.source.ref)
      if (isErr(cloned)) {
        logger.error("extension install failed", {
          id: String(p.id),
          kind: cloned.error.kind,
        })
        return cloned
      }
      const revved = await deps.git.revParse(writeDir)
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
      const writeDir = p.writeDir as string
      const copied = await deps.copier.copy(p.source.path, writeDir)
      if (isErr(copied)) {
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

    const pluginInstall: PluginInstall =
      p.source.kind === "git"
        ? {
            id: p.id,
            source: {
              kind: "git",
              url: p.source.url,
              ref: p.source.ref,
              commit: commit as string,
            },
            enabled: true,
          }
        : {
            id: p.id,
            source: {
              kind: "path",
              path: p.source.path,
              linked: p.source.linked,
            },
            enabled: true,
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
    if (current.source.kind !== "git") {
      const detail =
        current.source.kind === "local"
          ? `cannot update a local hand-placed extension: ${id}`
          : `cannot update a linked extension, there is nothing to fetch: ${id}`
      const error: PluginError = { kind: "invalid-manifest", detail }
      logger.error("extension update failed", {
        id: String(id),
        kind: error.kind,
      })
      return err(error)
    }

    const dir = join(deps.pluginRoot, String(id))

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

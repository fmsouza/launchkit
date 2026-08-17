import type {
  Config,
  ConfigError,
  ConfigStore,
  PluginInstall,
} from "@spectrum/config"
import type {
  ExtensionInstaller,
  ExtensionRegistry,
  InstallInput,
  InstalledExtension,
  PluginError,
} from "@spectrum/extensions"
import { type Logger, createNoopLogger } from "@spectrum/logger"
import type { ProviderHost } from "@spectrum/provider-host"
import { type PluginId, pluginKeyOf } from "@spectrum/types"
import { type Result, err, isErr, ok } from "@spectrum/utils"

/**
 * Extension install/lifecycle administration, wired at the composition root so the IPC layer
 * and the CLI share ONE implementation that performs the config write AND the refresh. Every
 * method mutates `config` then awaits `refresh()` — never one without the other, and never a
 * refresh on a mutation that did not happen (install failure calls neither).
 */
export interface ExtensionAdmin {
  install(input: InstallInput): Promise<Result<InstalledExtension, PluginError>>
  update(id: PluginId): Promise<Result<InstalledExtension, PluginError>>
  remove(id: PluginId): Promise<Result<void, PluginError>>
  setEnabled(id: PluginId, enabled: boolean): Promise<Result<void, PluginError>>
}

/** `ConfigError` has no `detail` field for `not-found`; every other variant does. Preserving
 * the real detail (rather than collapsing every kind to its own name) is what lets a user tell
 * "no config on disk yet" apart from "your config file is corrupt" or "permission denied". */
const configErrorDetail = (e: ConfigError): string =>
  e.kind === "not-found" ? "not-found" : `${e.kind}: ${e.detail}`

/** Bounds a log line to a fixed length. `registry.list()`'s `invalid-manifest` detail can carry
 * a multi-line zod validation dump — fine as a `PluginError` returned to a caller that wants the
 * full detail, but unbounded text has no place in a single structured log line. */
const summarizeForLog = (detail: string, max = 200): string =>
  detail.length > max ? `${detail.slice(0, max)}…` : detail

export const createExtensionAdmin = (deps: {
  readonly config: ConfigStore
  readonly installer: ExtensionInstaller
  readonly registry: ExtensionRegistry
  readonly providerHost: ProviderHost
  readonly refresh: () => Promise<void>
  readonly logger?: Logger
}): ExtensionAdmin => {
  const logger = deps.logger ?? createNoopLogger()

  const loadConfig = async (): Promise<Result<Config, PluginError>> => {
    const loaded = await deps.config.load()
    if (isErr(loaded))
      return err({
        kind: "read-failed",
        detail: configErrorDetail(loaded.error),
      })
    return ok(loaded.value)
  }

  const saveConfig = async (
    next: Config,
  ): Promise<Result<void, PluginError>> => {
    const saved = await deps.config.save(next)
    if (isErr(saved))
      return err({
        kind: "write-failed",
        detail: configErrorDetail(saved.error),
      })
    return ok(undefined)
  }

  // Rollback: `installer.install` already wrote (cloned/copied) the extension, but the config
  // record that makes it "installed" never landed — whether because the config couldn't even
  // be READ (a corrupt/unreadable config.json) or because the write itself failed. Either way,
  // without this the on-disk directory is orphaned — invisible to the user, but occupying the
  // id, so a retry hits `duplicate-id` (copy) or a clone into a non-empty directory (git) with
  // no recovery short of manually deleting it.
  const rollbackInstall = async (
    installed: InstalledExtension,
    reason: "config-load-failed" | "config-save-failed",
  ): Promise<void> => {
    const rollback = await deps.installer.remove(
      installed.install.id,
      installed.install,
      [],
    )
    if (isErr(rollback)) {
      logger.error(
        "extension install: rollback after a post-install step failed also failed",
        {
          id: String(installed.install.id),
          reason,
          kind: rollback.error.kind,
        },
      )
    }
  }

  const install = async (
    input: InstallInput,
  ): Promise<Result<InstalledExtension, PluginError>> => {
    const installed = await deps.installer.install(input)
    if (isErr(installed)) return installed

    const cfg = await loadConfig()
    if (isErr(cfg)) {
      await rollbackInstall(installed.value, "config-load-failed")
      return cfg
    }

    const next: Config = {
      ...cfg.value,
      providerPlugins: [...cfg.value.providerPlugins, installed.value.install],
    }
    const saved = await saveConfig(next)
    if (isErr(saved)) {
      await rollbackInstall(installed.value, "config-save-failed")
      return saved
    }

    logger.info("extension admin mutation", {
      id: String(installed.value.install.id),
      op: "install",
    })
    await deps.refresh()
    return ok(installed.value)
  }

  const findInstall = (cfg: Config, id: PluginId): PluginInstall | undefined =>
    cfg.providerPlugins.find((p) => String(p.id) === String(id))

  const setEnabled = async (
    id: PluginId,
    enabled: boolean,
  ): Promise<Result<void, PluginError>> => {
    const cfg = await loadConfig()
    if (isErr(cfg)) return cfg

    const current = findInstall(cfg.value, id)
    if (current === undefined) return err({ kind: "not-found", id: String(id) })

    const next: Config = {
      ...cfg.value,
      providerPlugins: cfg.value.providerPlugins.map((p) =>
        String(p.id) === String(id) ? { ...p, enabled } : p,
      ),
    }
    const saved = await saveConfig(next)
    if (isErr(saved)) return saved

    logger.info("extension admin mutation", {
      id: String(id),
      op: "setEnabled",
    })
    await deps.refresh()
    return ok(undefined)
  }

  const refuseInUse = (
    id: PluginId,
    providerIds: readonly string[],
  ): Result<void, PluginError> => {
    logger.warn("extension admin refusal", {
      id: String(id),
      op: "remove",
      kind: "in-use",
    })
    return err({ kind: "in-use", id: String(id), providerIds })
  }

  /**
   * Ordered so nothing DESTRUCTIVE (stopping a child, deleting a file, writing config) happens
   * until every refusal has had its chance to fire: (1) load config, (2) `registry.list()` →
   * this extension's contributed ids/keys (degrading per the comment below if listing fails),
   * (3) the FIRST `in-use` check against that config, (4) a re-load + re-check against a FRESH
   * config, THEN (5) stop, (6) delete, (7) drop the record from the step-4 config and save, (8)
   * refresh. An earlier version deleted the files and stopped the children BEFORE the re-check
   * could refuse, which left config still claiming the extension installed while its files were
   * already gone — worse than the race it was meant to narrow.
   */
  const remove = async (id: PluginId): Promise<Result<void, PluginError>> => {
    const cfg = await loadConfig()
    if (isErr(cfg)) return cfg

    const current = findInstall(cfg.value, id)
    if (current === undefined) return err({ kind: "not-found", id: String(id) })

    const listed = await deps.registry.list()

    // `registry.list()` fails the WHOLE batch on any one invalid manifest — including a
    // manifest belonging to some OTHER extension. Refusing `remove` here would make removal
    // unavailable exactly when it is the only recovery: the user cannot uninstall the broken
    // extension (or any extension) without hand-editing `config.json`. Degrade instead: proceed
    // with the delete, conservatively stopping EVERY supervised child (not just this
    // extension's contributions, which we can no longer enumerate) rather than none, and skip
    // the `in-use` computation — we cannot enumerate this extension's contribution ids either,
    // so there is nothing to check it against. A dangling `sdkProvider` on a provider record is
    // a visible, recoverable state the app already copes with; an extension that can never be
    // uninstalled is not.
    let contributedIds: readonly string[] = []
    let contributedKeys: readonly string[] = []
    let degraded = false

    if (isErr(listed)) {
      degraded = true
      logger.warn(
        "extension remove: manifest listing unavailable, degrading to a full stop",
        {
          id: String(id),
          kind: listed.error.kind,
          detail: summarizeForLog(
            "detail" in listed.error
              ? String(listed.error.detail)
              : listed.error.kind,
          ),
        },
      )
    } else {
      const ownEntries = listed.value.filter(
        (e) => String(e.manifest.id) === String(id),
      )
      contributedIds = ownEntries.flatMap((e) =>
        e.manifest.contributes.providers.map((p) => String(p.id)),
      )
      contributedKeys = ownEntries.flatMap((e) =>
        e.manifest.contributes.providers.map((p) => pluginKeyOf(p.id)),
      )
    }

    if (!degraded) {
      const referencingProviderIds = cfg.value.providers
        .filter((p) => contributedKeys.includes(p.sdkProvider))
        .map((p) => String(p.id))
      if (referencingProviderIds.length > 0)
        return refuseInUse(id, referencingProviderIds)
    }

    // Re-load BEFORE anything destructive: a provider record referencing this extension's
    // contribution could have been added between the FIRST check above and this point, and
    // (independently of `in-use`) some OTHER config edit could have landed too. Re-checking
    // narrows that window; it does not close it — there is no lock between this re-check and
    // `saveConfig` below, so a write landing in that exact gap can still race past it.
    // Unconditional, even when `degraded`: without `contributedKeys` there is nothing to
    // re-check `in-use` against, but the WRITE below still must not silently erase whatever
    // config changed since the first load — that is a plain stale read-modify-write bug, not a
    // narrower version of the `in-use` race.
    const freshCfg = await loadConfig()
    if (isErr(freshCfg)) return freshCfg
    if (!degraded) {
      const stillReferencing = freshCfg.value.providers
        .filter((p) => contributedKeys.includes(p.sdkProvider))
        .map((p) => String(p.id))
      if (stillReferencing.length > 0) return refuseInUse(id, stillReferencing)
    }

    if (degraded) {
      await deps.providerHost.stopAll()
    } else {
      for (const contributionId of contributedIds) {
        await deps.providerHost.stopAllFor(contributionId)
      }
    }

    const removed = await deps.installer.remove(id, current, [])
    if (isErr(removed)) return removed

    const next: Config = {
      ...freshCfg.value,
      providerPlugins: freshCfg.value.providerPlugins.filter(
        (p) => String(p.id) !== String(id),
      ),
    }
    const saved = await saveConfig(next)
    if (isErr(saved)) return saved

    logger.info("extension admin mutation", { id: String(id), op: "remove" })
    await deps.refresh()
    return ok(undefined)
  }

  const update = async (
    id: PluginId,
  ): Promise<Result<InstalledExtension, PluginError>> => {
    const cfg = await loadConfig()
    if (isErr(cfg)) return cfg

    const current = findInstall(cfg.value, id)
    if (current === undefined) return err({ kind: "not-found", id: String(id) })

    const updated = await deps.installer.update(id, current)
    if (isErr(updated)) return updated

    const next: Config = {
      ...cfg.value,
      providerPlugins: cfg.value.providerPlugins.map((p) =>
        String(p.id) === String(id) ? updated.value.install : p,
      ),
    }
    const saved = await saveConfig(next)
    if (isErr(saved)) return saved

    logger.info("extension admin mutation", { id: String(id), op: "update" })
    await deps.refresh()
    return ok(updated.value)
  }

  return { install, update, remove, setEnabled }
}

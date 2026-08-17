import type { Config, ConfigStore, PluginInstall } from "@spectrum/config"
import type {
  ExtensionInstaller,
  ExtensionRegistry,
  InstallInput,
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
  install(input: InstallInput): Promise<Result<void, PluginError>>
  update(id: PluginId): Promise<Result<void, PluginError>>
  remove(id: PluginId): Promise<Result<void, PluginError>>
  setEnabled(id: PluginId, enabled: boolean): Promise<Result<void, PluginError>>
}

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
      return err({ kind: "read-failed", detail: loaded.error.kind })
    return ok(loaded.value)
  }

  const saveConfig = async (
    next: Config,
  ): Promise<Result<void, PluginError>> => {
    const saved = await deps.config.save(next)
    if (isErr(saved))
      return err({ kind: "write-failed", detail: saved.error.kind })
    return ok(undefined)
  }

  const install = async (
    input: InstallInput,
  ): Promise<Result<void, PluginError>> => {
    const installed = await deps.installer.install(input)
    if (isErr(installed)) return installed

    const cfg = await loadConfig()
    if (isErr(cfg)) return cfg

    const next: Config = {
      ...cfg.value,
      providerPlugins: [...cfg.value.providerPlugins, installed.value.install],
    }
    const saved = await saveConfig(next)
    if (isErr(saved)) return saved

    logger.info("extension admin mutation", {
      id: String(installed.value.install.id),
      op: "install",
    })
    await deps.refresh()
    return ok(undefined)
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

  const remove = async (id: PluginId): Promise<Result<void, PluginError>> => {
    const cfg = await loadConfig()
    if (isErr(cfg)) return cfg

    const current = findInstall(cfg.value, id)
    if (current === undefined) return err({ kind: "not-found", id: String(id) })

    const listed = await deps.registry.list()
    if (isErr(listed)) return listed

    const contributedKeys = listed.value
      .filter((e) => String(e.manifest.id) === String(id))
      .flatMap((e) =>
        e.manifest.contributes.providers.map((p) => pluginKeyOf(p.id)),
      )
    const referencingProviderIds = cfg.value.providers
      .filter((p) => contributedKeys.includes(p.sdkProvider))
      .map((p) => String(p.id))

    if (referencingProviderIds.length > 0) {
      const error: PluginError = {
        kind: "in-use",
        id: String(id),
        providerIds: referencingProviderIds,
      }
      logger.info("extension admin mutation", { id: String(id), op: "remove" })
      return err(error)
    }

    const contributedIds = listed.value
      .filter((e) => String(e.manifest.id) === String(id))
      .flatMap((e) => e.manifest.contributes.providers.map((p) => String(p.id)))
    for (const contributionId of contributedIds) {
      await deps.providerHost.stopAllFor(contributionId)
    }

    const removed = await deps.installer.remove(id, current, [])
    if (isErr(removed)) return removed

    const next: Config = {
      ...cfg.value,
      providerPlugins: cfg.value.providerPlugins.filter(
        (p) => String(p.id) !== String(id),
      ),
    }
    const saved = await saveConfig(next)
    if (isErr(saved)) return saved

    logger.info("extension admin mutation", { id: String(id), op: "remove" })
    await deps.refresh()
    return ok(undefined)
  }

  const update = async (id: PluginId): Promise<Result<void, PluginError>> => {
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
    return ok(undefined)
  }

  return { install, update, remove, setEnabled }
}

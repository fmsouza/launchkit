import { type Logger, createNoopLogger } from "@spectrum/logger"
import type { ProviderDescriptor } from "@spectrum/providers"
import { type Result, err, isErr, ok } from "@spectrum/utils"
import { descriptorFromContribution } from "./descriptor"
import { validateContributionTemplates } from "./env-template"
import type { PluginError } from "./errors"
import type { ExtensionFileSource } from "./file-source"
import type { ExtensionManifest, ParsedManifest } from "./manifest"
import { parseManifest } from "./manifest"

/** One extension whose manifest parsed and whose templates validated. */
export type LoadedExtension = {
  readonly manifest: ExtensionManifest
  readonly ignoredContributions: readonly string[]
  readonly dir: string
}

export interface ExtensionRegistry {
  list(): Promise<Result<readonly LoadedExtension[], PluginError>>
  providerDescriptors(
    enabledIds: readonly string[],
  ): Promise<Result<readonly ProviderDescriptor[], PluginError>>
}

/**
 * Parses every extension the file source reports, rejects duplicate manifest ids AND duplicate
 * provider-CONTRIBUTION ids across the whole installed set, and validates every provider
 * contribution's launch templates. A `source-unavailable` entry from the
 * file source (a dead linked path) is logged and skipped — it does not fail the batch,
 * unlike a genuinely invalid manifest, an unsupported api version, or a duplicate id,
 * which do fail the whole `list()` call.
 */
export const createExtensionRegistry = (deps: {
  readonly fileSource: ExtensionFileSource
  readonly logger?: Logger
}): ExtensionRegistry => {
  const logger = deps.logger ?? createNoopLogger()

  /**
   * Attach the extension directory id `list()` is currently walking to an
   * `invalid-manifest`/`unsupported-api-version` error that doesn't already carry one.
   * `parseManifest` and `validateContributionTemplates` are pure and never see a directory,
   * so they can't attribute their own failures — `list()` is the one place that knows WHICH
   * entry produced them, and without this a single bad manifest failing the whole batch gives
   * the caller no way to say which extension is broken (Global Constraint 2 forbids a new
   * `PluginError` variant, not a field on an existing one — this only ever fills a field that
   * was already optional).
   */
  const withEntryId = (error: PluginError, id: string): PluginError =>
    error.kind === "invalid-manifest" ||
    error.kind === "unsupported-api-version"
      ? { ...error, id: error.id ?? id }
      : error

  const list = async (): Promise<
    Result<readonly LoadedExtension[], PluginError>
  > => {
    const read = await deps.fileSource.listExtensions()
    if (isErr(read)) return read

    const loaded: LoadedExtension[] = []
    const seenIds = new Set<string>()
    const seenContributionIds = new Set<string>()

    for (const entry of read.value) {
      if ("error" in entry) {
        logger.warn("extension source unavailable", {
          id: entry.id,
          kind: entry.error.kind,
        })
        continue
      }

      const parsed: Result<ParsedManifest, PluginError> = parseManifest(
        entry.raw,
      )
      if (isErr(parsed)) return err(withEntryId(parsed.error, entry.id))
      const { manifest, ignoredContributions } = parsed.value

      // The directory an extension was read from (entry.id) and the identity it declares
      // (manifest.id, which becomes plugin:<id>) must agree — otherwise `dir` below would
      // point at a location the manifest never actually claimed, silently breaking
      // uninstall-by-id later.
      if (entry.id !== manifest.id) {
        return err({
          kind: "invalid-manifest",
          detail: `extension directory id "${entry.id}" does not match manifest id "${manifest.id}"`,
          id: entry.id,
        })
      }

      if (seenIds.has(manifest.id)) {
        return err({ kind: "duplicate-id", id: manifest.id })
      }
      seenIds.add(manifest.id)

      for (const contribution of manifest.contributes.providers) {
        const templates = validateContributionTemplates(contribution)
        if (isErr(templates)) return err(withEntryId(templates.error, entry.id))

        // SECURITY: the contribution id — not the manifest id — is what becomes `plugin:<id>`
        // and what the supervisor keys on when it spawns a launch block. Two extensions
        // claiming one contribution id would make "which extension does `plugin:acme` spawn"
        // depend on the order the file source happened to read directories in, so an
        // attacker's manifest could have its command spawned with another plugin's secrets.
        // Refuse the whole batch rather than pick a winner.
        const contributionId = String(contribution.id)
        if (seenContributionIds.has(contributionId)) {
          return err({ kind: "duplicate-id", id: contributionId })
        }
        seenContributionIds.add(contributionId)
      }

      if (ignoredContributions.length > 0) {
        logger.warn("extension declares unsupported contributions", {
          id: manifest.id,
          ignoredContributions,
        })
      }

      loaded.push({
        manifest,
        ignoredContributions,
        dir: deps.fileSource.extensionDir(manifest.id),
      })
    }

    return ok(loaded)
  }

  return {
    list,
    providerDescriptors: async (
      enabledIds: readonly string[],
    ): Promise<Result<readonly ProviderDescriptor[], PluginError>> => {
      const result = await list()
      if (isErr(result)) return result

      const enabled = new Set(enabledIds)
      const descriptors = result.value
        .filter((e) => enabled.has(e.manifest.id))
        .flatMap((e) =>
          e.manifest.contributes.providers.map(descriptorFromContribution),
        )
      return ok(descriptors)
    },
  }
}

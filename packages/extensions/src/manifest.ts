import { PluginIdSchema } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import { z } from "zod"
import { isSupportedApiVersion } from "./api-version"
import type { PluginError } from "./errors"
import { ProviderContributionSchema } from "./provider-contribution"

/** Contribution keys this Spectrum understands. Anything else is ignored, not rejected. */
export const KNOWN_CONTRIBUTION_KEYS = ["providers"] as const

/**
 * The `contributes` object is the ONE passthrough in the manifest: known keys are
 * validated, unknown keys pass through untouched so a manifest written for a future
 * Spectrum still installs here and simply contributes less. The manifest ROOT stays
 * strict, so a typo at the top level is a loud error rather than a silent no-op.
 */
const ContributesSchema = z
  .object({ providers: z.array(ProviderContributionSchema).default([]) })
  .passthrough()

export const ExtensionManifestSchema = z
  .object({
    apiVersion: z.string().min(1),
    id: PluginIdSchema,
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    contributes: ContributesSchema.default({ providers: [] }),
  })
  .strict()
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>

export type ParsedManifest = {
  readonly manifest: ExtensionManifest
  /** Contribution keys present but not understood — surfaced so the UI/log can say so. */
  readonly ignoredContributions: readonly string[]
}

/** Validate a raw manifest: api-version gate first, then shape, then note what was ignored. */
export const parseManifest = (
  raw: unknown,
): Result<ParsedManifest, PluginError> => {
  const version = (raw as { apiVersion?: unknown } | null)?.apiVersion
  if (typeof version !== "string" || !isSupportedApiVersion(version))
    return err({
      kind: "unsupported-api-version",
      apiVersion: typeof version === "string" ? version : String(version),
    })
  const parsed = ExtensionManifestSchema.safeParse(raw)
  if (!parsed.success)
    return err({ kind: "invalid-manifest", detail: parsed.error.message })
  const known = new Set<string>(KNOWN_CONTRIBUTION_KEYS)
  const ignoredContributions = Object.keys(parsed.data.contributes).filter(
    (k) => !known.has(k),
  )
  return ok({ manifest: parsed.data, ignoredContributions })
}

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
  .superRefine((c, ctx) => {
    // A manifest colliding with ITSELF is worse than colliding with a neighbour: the
    // registry's `list()` dedupes contribution ids across the whole installed set in one
    // pass (registry.ts:91), so a self-colliding manifest that ever reached disk would
    // brick every other installed plugin on the next load, not just itself. Reject it
    // here, at the one seam every manifest source (git clone, copy, link, and a
    // hand-placed directory the installer never touched) passes through.
    // `break` after the first collision: this loop runs over attacker-controlled content
    // (an installed or about-to-be-installed manifest), and `addIssue` per duplicate with
    // no bound turns a manifest with N duplicate ids into an N-issue, unboundedly long
    // `detail` string on the `PluginError` this ultimately becomes — one issue is enough
    // to report and reject.
    const seen = new Set<string>()
    for (const provider of c.providers) {
      const id = String(provider.id)
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `contributes.providers declares the id "${id}" more than once`,
          path: ["providers"],
        })
        break
      }
      seen.add(id)
    }
  })

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

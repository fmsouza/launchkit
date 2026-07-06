import { z } from "zod"
import { ModelIdSchema, ProviderIdSchema } from "./ids"

export const ModelRouteSchema = z
  .object({
    id: ModelIdSchema,
    providerId: ProviderIdSchema,
    providerModel: z.string().min(1),
    /** Optional user-set aliases/tiers (e.g. "haiku", "small") so a sub-agent that requests a
     *  different tier than the session model maps to THIS route instead of collapsing to it. */
    aliases: z.array(z.string()).default([]),
    /**
     * What the routed model can receive as attachments. Absent key = unknown,
     * which the composer gates OFF (override in the model form to enable).
     */
    attachments: z
      .object({ image: z.boolean().optional(), pdf: z.boolean().optional() })
      .strict()
      .default({}),
    /** Who last set `attachments` — re-discovery must never clobber a user's override. */
    attachmentsSource: z.enum(["user", "auto"]).optional(),
  })
  .strict()

export type ModelRoute = z.infer<typeof ModelRouteSchema>

/**
 * Wire-name prefix for proxied routes whose model can receive image/PDF
 * attachments. The Claude Code CLI gates multimodal blocks by model NAME:
 * `claude-*` names pass, unknown names get text placeholders. The proxy
 * router strips this prefix back to the exact route id (router step 0).
 */
export const WIRE_ALIAS_PREFIX = "claude-spectrum-"

/**
 * The model name the CLI should see for a proxied route: alias-prefixed when
 * the route can carry image or PDF attachments (so the CLI ships real blocks),
 * the raw route id otherwise. Pure.
 */
export const wireModelFor = (route: ModelRoute): string =>
  route.attachments.image === true || route.attachments.pdf === true
    ? `${WIRE_ALIAS_PREFIX}${String(route.id)}`
    : String(route.id)

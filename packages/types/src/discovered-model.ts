import { z } from "zod"

/**
 * One model surfaced by provider discovery: the provider-native id plus any
 * attachment-capability metadata the provider's listing exposed (openrouter
 * modalities, ollama families). `attachments` absent = provider said nothing
 * (consumers fall back to the name heuristic).
 */
export const DiscoveredModelSchema = z
  .object({
    id: z.string().min(1),
    attachments: z
      .object({ image: z.boolean().optional(), pdf: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict()

export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>

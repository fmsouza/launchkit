import {
  ConfigFieldSpecSchema,
  DiscoverySchema,
  ProviderActionSchema,
  ReasoningSupportSchema,
  SecretFieldSpecSchema,
  defaultActions,
} from "@spectrum/providers"
import { PluginIdSchema } from "@spectrum/types"
import { z } from "zod"

/** How a plugin's provider server is launched as a local child process. */
export const PluginLaunchSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    envTemplate: z.record(z.string(), z.string()),
    cwd: z.string().min(1).optional(),
    healthPath: z.string().startsWith("/").default("/models"),
    readyTimeoutMs: z.number().int().min(1000).max(120_000).default(10_000),
  })
  .strict()
export type PluginLaunch = z.infer<typeof PluginLaunchSchema>

/** One LLM provider a plugin contributes: its descriptor + how to reach its server. */
export const ProviderContributionSchema = z
  .object({
    id: PluginIdSchema,
    descriptor: z
      .object({
        label: z.string().min(1),
        configFields: z.array(ConfigFieldSpecSchema).default([]),
        secretFields: z.array(SecretFieldSpecSchema).default([]),
        supportsCustomHeaders: z.boolean().default(false),
        streaming: z.enum(["incremental", "buffered"]).default("incremental"),
        reasoning: ReasoningSupportSchema,
        discovery: DiscoverySchema,
        actions: z.array(ProviderActionSchema).optional(),
      })
      .strict(),
    transport: z
      .object({
        // Discriminant reserved so a stdio JSON-RPC transport can be added later
        // without a manifest redesign. Only "http" is implemented.
        kind: z.literal("http"),
        wire: z.enum(["openai", "anthropic"]),
        launch: PluginLaunchSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .transform((c) => ({
    ...c,
    descriptor: {
      ...c.descriptor,
      // A contribution that declares no actions gets exactly what a builtin gets.
      actions:
        c.descriptor.actions ??
        defaultActions(c.descriptor.secretFields.length > 0),
    },
  }))
export type ProviderContribution = z.infer<typeof ProviderContributionSchema>

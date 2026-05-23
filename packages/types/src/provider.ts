import { z } from "zod"
import { SdkProviderSchema } from "./enums"
import { ProviderIdSchema, SecretRefSchema } from "./ids"

export const ProviderSchema = z.object({
  id: ProviderIdSchema,
  name: z.string().min(1),
  sdkProvider: SdkProviderSchema,
  config: z.record(z.string(), z.string()),
  secrets: z.record(z.string(), SecretRefSchema),
  models: z.array(z.string()),
}).strict()

export type Provider = z.infer<typeof ProviderSchema>

import { z } from "zod"
import { ProviderIdSchema, SdkProviderSchema } from "@launchkit/types"

/** Presence flag for one secret field — never a `ref`, never a value. */
export const SecretFieldStatusSchema = z.object({ isSet: z.boolean() }).strict()
export type SecretFieldStatus = z.infer<typeof SecretFieldStatusSchema>

/**
 * The provider shape exposed to the webview. Identical to `Provider` except
 * `secrets` (keychain refs) is replaced by `secretFields` (presence flags only),
 * enforcing `security.md`: no secret value or ref ever crosses IPC to the GUI.
 */
export const ProviderViewSchema = z.object({
  id: ProviderIdSchema,
  name: z.string().min(1),
  sdkProvider: SdkProviderSchema,
  config: z.record(z.string(), z.string()),
  secretFields: z.record(z.string(), SecretFieldStatusSchema),
  models: z.array(z.string()),
}).strict()

export type ProviderView = z.infer<typeof ProviderViewSchema>

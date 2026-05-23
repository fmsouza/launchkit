import { z } from "zod"

export const ProviderIdSchema = z.string().min(1).brand<"ProviderId">()
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const AliasNameSchema = z.string().min(1).brand<"AliasName">()
export type AliasName = z.infer<typeof AliasNameSchema>

export const HarnessIdSchema = z.string().min(1).brand<"HarnessId">()
export type HarnessId = z.infer<typeof HarnessIdSchema>

export const SessionIdSchema = z.string().min(1).brand<"SessionId">()
export type SessionId = z.infer<typeof SessionIdSchema>

export const SecretRefSchema = z.object({ ref: z.string().min(1) }).strict()
export type SecretRef = z.infer<typeof SecretRefSchema>

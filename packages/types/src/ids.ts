import { z } from "zod"

export const ProviderIdSchema = z.string().min(1).brand<"ProviderId">()
export type ProviderId = z.infer<typeof ProviderIdSchema>

export const ModelIdSchema = z.string().min(1).brand<"ModelId">()
export type ModelId = z.infer<typeof ModelIdSchema>

export const HarnessIdSchema = z.string().min(1).brand<"HarnessId">()
export type HarnessId = z.infer<typeof HarnessIdSchema>

export const SessionIdSchema = z.string().min(1).brand<"SessionId">()
export type SessionId = z.infer<typeof SessionIdSchema>

export const ProjectIdSchema = z.string().min(1).brand<"ProjectId">()
export type ProjectId = z.infer<typeof ProjectIdSchema>

export const SecretRefSchema = z.object({ ref: z.string().min(1) }).strict()
export type SecretRef = z.infer<typeof SecretRefSchema>

export const RunnerIdSchema = z.string().min(1).brand<"RunnerId">()
export type RunnerId = z.infer<typeof RunnerIdSchema>

/** A provider plugin's id: lowercase slug, used to build its `plugin:<id>` provider key. */
export const PluginIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .brand<"PluginId">()
export type PluginId = z.infer<typeof PluginIdSchema>

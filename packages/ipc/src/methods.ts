import { z } from "zod"
import {
  ProviderIdSchema,
  SdkProviderSchema,
  AliasNameSchema,
  HarnessIdSchema,
  ModelAliasSchema,
  HarnessDefinitionSchema,
  SessionSchema,
} from "@launchkit/types"
import { ProviderViewSchema } from "./provider-view"

/** `void` over the wire is encoded as `null` (JSON has no `undefined`). */
const VoidSchema = z.null()

// ── Providers ────────────────────────────────────────────────────────────────

export const GetProvidersParamsSchema = z.undefined()
export const GetProvidersResultSchema = z.array(ProviderViewSchema)

/**
 * Add/Update provider inputs carry only NON-secret config + the list of secret
 * field *names* the provider expects. `.strict()` rejects any smuggled `secrets`
 * key — raw values arrive only via `setProviderSecret`.
 */
const ProviderMutationInputSchema = z.object({
  name: z.string().min(1),
  sdkProvider: SdkProviderSchema,
  config: z.record(z.string(), z.string()),
  secretFieldNames: z.array(z.string()),
  models: z.array(z.string()),
}).strict()

export const AddProviderParamsSchema = ProviderMutationInputSchema
export const AddProviderResultSchema = ProviderViewSchema

export const UpdateProviderParamsSchema = z.object({
  id: ProviderIdSchema,
  input: ProviderMutationInputSchema,
}).strict()
export const UpdateProviderResultSchema = ProviderViewSchema

export const DeleteProviderParamsSchema = z.object({ id: ProviderIdSchema }).strict()
export const DeleteProviderResultSchema = VoidSchema

export const TestProviderParamsSchema = z.object({ id: ProviderIdSchema }).strict()
export const TestProviderResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
}).strict()

/**
 * The ONLY method whose params carry a raw secret value, and it is inbound
 * (webview→main) only — there is no corresponding main→webview result that
 * echoes it back (returns void).
 */
export const SetProviderSecretParamsSchema = z.object({
  providerId: ProviderIdSchema,
  field: z.string().min(1),
  value: z.string().min(1),
}).strict()
export const SetProviderSecretResultSchema = VoidSchema

// ── Aliases ──────────────────────────────────────────────────────────────────

export const GetAliasesParamsSchema = z.undefined()
export const GetAliasesResultSchema = z.array(ModelAliasSchema)

/** Add accepts a full alias mapping; the alias name is part of the body. */
export const AddAliasParamsSchema = ModelAliasSchema
export const AddAliasResultSchema = ModelAliasSchema

/** Update keys by alias name and carries the new mapping (sans the key). */
export const UpdateAliasParamsSchema = z.object({
  alias: AliasNameSchema,
  input: ModelAliasSchema.omit({ alias: true }),
}).strict()
export const UpdateAliasResultSchema = ModelAliasSchema

export const DeleteAliasParamsSchema = z.object({ alias: AliasNameSchema }).strict()
export const DeleteAliasResultSchema = VoidSchema

// ── Harnesses ─────────────────────────────────────────────────────────────────

export const GetHarnessesParamsSchema = z.undefined()
export const GetHarnessesResultSchema = z.array(HarnessDefinitionSchema)

/** Add accepts a full definition (user-defined harnesses arrive as JSON shapes). */
export const AddHarnessParamsSchema = HarnessDefinitionSchema
export const AddHarnessResultSchema = HarnessDefinitionSchema

export const UpdateHarnessParamsSchema = z.object({
  id: HarnessIdSchema,
  input: HarnessDefinitionSchema.omit({ id: true }),
}).strict()
export const UpdateHarnessResultSchema = HarnessDefinitionSchema

export const DeleteHarnessParamsSchema = z.object({ id: HarnessIdSchema }).strict()
export const DeleteHarnessResultSchema = VoidSchema

export const LaunchHarnessParamsSchema = z.object({
  id: HarnessIdSchema,
  alias: AliasNameSchema.optional(),
}).strict()
export const LaunchHarnessResultSchema = SessionSchema

// ── Sessions & proxy ──────────────────────────────────────────────────────────

export const GetSessionsParamsSchema = z.object({
  harnessId: HarnessIdSchema.optional(),
  alias: AliasNameSchema.optional(),
}).strict().optional()
export const GetSessionsResultSchema = z.array(SessionSchema)

export const GetProxyStatusParamsSchema = z.undefined()
export const GetProxyStatusResultSchema = z.object({
  running: z.boolean(),
  port: z.number().int().nonnegative(),
}).strict()

// ── The method → {params, result} schema map ──────────────────────────────────

/** Maps each contract method to its on-the-wire param + result zod schemas. */
export const IpcMethodSchemas = {
  getProviders: { params: GetProvidersParamsSchema, result: GetProvidersResultSchema },
  addProvider: { params: AddProviderParamsSchema, result: AddProviderResultSchema },
  updateProvider: { params: UpdateProviderParamsSchema, result: UpdateProviderResultSchema },
  deleteProvider: { params: DeleteProviderParamsSchema, result: DeleteProviderResultSchema },
  testProvider: { params: TestProviderParamsSchema, result: TestProviderResultSchema },
  setProviderSecret: { params: SetProviderSecretParamsSchema, result: SetProviderSecretResultSchema },
  getAliases: { params: GetAliasesParamsSchema, result: GetAliasesResultSchema },
  addAlias: { params: AddAliasParamsSchema, result: AddAliasResultSchema },
  updateAlias: { params: UpdateAliasParamsSchema, result: UpdateAliasResultSchema },
  deleteAlias: { params: DeleteAliasParamsSchema, result: DeleteAliasResultSchema },
  getHarnesses: { params: GetHarnessesParamsSchema, result: GetHarnessesResultSchema },
  addHarness: { params: AddHarnessParamsSchema, result: AddHarnessResultSchema },
  updateHarness: { params: UpdateHarnessParamsSchema, result: UpdateHarnessResultSchema },
  deleteHarness: { params: DeleteHarnessParamsSchema, result: DeleteHarnessResultSchema },
  launchHarness: { params: LaunchHarnessParamsSchema, result: LaunchHarnessResultSchema },
  getSessions: { params: GetSessionsParamsSchema, result: GetSessionsResultSchema },
  getProxyStatus: { params: GetProxyStatusParamsSchema, result: GetProxyStatusResultSchema },
} as const

/** The set of valid method names, derived from the schema map. */
export type IpcMethodName = keyof typeof IpcMethodSchemas

/**
 * The typed contract: method name → its params + result TypeScript types,
 * inferred from the schemas above (single source of truth).
 */
export type IpcMethods = {
  readonly [K in IpcMethodName]: {
    readonly params: z.infer<(typeof IpcMethodSchemas)[K]["params"]>
    readonly result: z.infer<(typeof IpcMethodSchemas)[K]["result"]>
  }
}

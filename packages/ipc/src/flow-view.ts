import { z } from "zod"

/**
 * The setup-flow protocol as disclosed to the GUI.
 *
 * Every schema here is a deliberate HAND-WRITTEN DUPLICATE of its counterpart in
 * `@spectrum/extensions` (`packages/extensions/src/flow.ts`) — `FlowStepSchema`,
 * `FlowResultSchema`, `FlowToastSchema`. `packages/ipc` is a leaf that gets bundled into the
 * webview and `@spectrum/extensions` drags a logger and fs adapters in with it, exactly the
 * reasoning `extension-view.ts` already records for `ExtensionSourceSchema`.
 *
 * Keep the two in sync BY HAND. A drift test in `apps/desktop` (which depends on both
 * packages) feeds one fixture set through both unions and asserts identical accept/reject for
 * every non-`done` kind, plus the ONE intended divergence below.
 *
 * THE DIVERGENCE: `done` here carries `message` and NOTHING ELSE. The plugin's `done` step may
 * carry `config` and `secrets`; those are consumed in the main process (keychain + config
 * file) and must never cross to the renderer. `.strict()` on that member is what makes
 * "rejects a done step carrying secrets" a real guard rather than a formality.
 */

/**
 * Only http(s) may be offered to the OS opener. Mirrors `isSafeExternalUrl`
 * (`@spectrum/extensions`); duplicated for the leaf-package reason above.
 */
const isSafeFlowUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export const FlowFieldViewSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["text", "url", "password", "select"]),
    required: z.boolean(),
    placeholder: z.string().optional(),
    options: z
      .array(z.object({ value: z.string(), label: z.string() }).strict())
      .optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    // A `select` with no options has nothing to render. Refused here so the renderer never
    // has to decide what an empty dropdown means.
    if (field.kind === "select" && (field.options?.length ?? 0) === 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a select field must declare at least one option",
        path: ["options"],
      })
  })
export type FlowFieldViewData = z.infer<typeof FlowFieldViewSchema>

/** A step's `tone` is the three non-failure tones; a hard failure is the `error` KIND. */
const MESSAGE_TONE = ["info", "success", "warning"] as const

export const FlowStepViewSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("form"),
      title: z.string().min(1),
      description: z.string().optional(),
      fields: z.array(FlowFieldViewSchema),
      submitLabel: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      title: z.string().min(1),
      body: z.string(),
      tone: z.enum(MESSAGE_TONE),
      continueLabel: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-external"),
      title: z.string().min(1),
      description: z.string().optional(),
      url: z.string().refine(isSafeFlowUrl, {
        message: "url must be http or https",
      }),
      buttonLabel: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("await"),
      title: z.string().min(1),
      description: z.string().optional(),
      pollMs: z.number().default(1000),
    })
    .strict(),
  // The sanitized `done`: `message` only. See THE DIVERGENCE above.
  z
    .object({
      kind: z.literal("done"),
      message: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      message: z.string(),
    })
    .strict(),
])
/**
 * Named `…Data`, not `FlowStepView`: `packages/ui` ships a `FlowStepView` COMPONENT and
 * declares its own local props type (it does not depend on `@spectrum/ipc`).
 */
export type FlowStepViewData = z.infer<typeof FlowStepViewSchema>

/**
 * What the renderer sends BACK for the current step. Travels webview → main, so it is
 * inbound external input like every other IPC param.
 */
export const FlowResultViewSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("form"),
      values: z.record(z.string(), z.string()),
    })
    .strict(),
  z.object({ kind: z.literal("ack") }).strict(),
  z.object({ kind: z.literal("poll") }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
])
export type FlowResultViewData = z.infer<typeof FlowResultViewSchema>

/** A transient banner accompanying a step. `error` is a tone here, not a terminal state. */
export const FlowToastViewSchema = z
  .object({
    tone: z.enum(["info", "success", "warning", "error"]),
    message: z.string(),
  })
  .strict()
export type FlowToastViewData = z.infer<typeof FlowToastViewSchema>

import { z } from "zod"

/** Server-root path prefix for a plugin's setup-flow endpoints. Deliberately independent of
 * the LLM `baseURL` path (spec §10.1), so a plugin whose wire prefix is `/v1` does not collide. */
export const FLOW_PATH_PREFIX = "/spectrum/v1/flow"

/**
 * Caps enforced by Spectrum's runner, never trusted from the plugin. A misbehaving or hung
 * extension must not be able to pin the UI or stream unbounded data at the main process.
 */
export const FLOW_LIMITS = {
  maxSteps: 50,
  totalTimeoutMs: 600_000,
  minPollMs: 500,
  maxPollMs: 10_000,
  maxBodyBytes: 262_144,
} as const

/**
 * Caps on the extension-controlled strings Spectrum renders VERBATIM.
 *
 * Not an injection boundary — React escapes every one of them — a LAYOUT one. Without a bound
 * the only limit on a step's title, body or error message is `maxBodyBytes` (256 KB), and a
 * step that ships a quarter-megabyte "title" pushes the setup modal's own cancel button off
 * the screen with nothing but the window chrome left to escape by.
 *
 * `maxTitleChars` covers the strings that render as a heading or a button label: 200
 * characters is already about two full lines at the modal's width, so a real title never
 * comes near it. `maxBodyChars` covers prose — a `message` body, an `error`, an OAuth step's
 * "here is what happens next" paragraph: 2000 characters is roughly a printed page, which is
 * more than any of them needs and still finite.
 */
export const FLOW_TEXT_LIMITS = {
  maxTitleChars: 200,
  maxBodyChars: 2_000,
} as const

/** A heading or button label: non-empty, and short enough to stay a label. */
const titleText = (): z.ZodString =>
  z.string().min(1).max(FLOW_TEXT_LIMITS.maxTitleChars)
/** Prose. May be empty (a `message` body legitimately is), but never unbounded. */
const bodyText = (): z.ZodString =>
  z.string().max(FLOW_TEXT_LIMITS.maxBodyChars)

export const clampPollMs = (ms: number): number =>
  Math.min(Math.max(ms, FLOW_LIMITS.minPollMs), FLOW_LIMITS.maxPollMs)

/**
 * Only http(s) may be handed to the OS opener. Any other scheme would make Spectrum a
 * launcher for arbitrary registered URL handlers on behalf of an extension.
 */
export const isSafeExternalUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export const FlowFieldSchema = z
  .object({
    name: z.string().min(1),
    label: titleText(),
    kind: z.enum(["text", "url", "password", "select"]),
    required: z.boolean(),
    placeholder: z.string().max(FLOW_TEXT_LIMITS.maxTitleChars).optional(),
    options: z
      .array(z.object({ value: z.string(), label: titleText() }).strict())
      .optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    // A `select` field with no options has nothing to render — reject it here, at parse
    // time, rather than letting the UI render an empty dropdown.
    if (field.kind === "select" && (field.options?.length ?? 0) === 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a select field must declare at least one option",
        path: ["options"],
      })
  })
export type FlowField = z.infer<typeof FlowFieldSchema>

// Spec §10.2. `message.tone` is exactly the three values below — unlike `toast.tone`, which
// adds "error" (see FlowToastSchema) — because a flow step is never used to report a hard
// failure; that is what the "error" step kind is for.
const MESSAGE_TONE = ["info", "success", "warning"] as const

export const FlowStepSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("form"),
      title: titleText(),
      description: bodyText().optional(),
      fields: z.array(FlowFieldSchema),
      submitLabel: titleText().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      title: titleText(),
      body: bodyText(),
      tone: z.enum(MESSAGE_TONE),
      continueLabel: titleText().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-external"),
      title: titleText(),
      description: bodyText().optional(),
      url: z.string().refine(isSafeExternalUrl, {
        message: "url must be http or https",
      }),
      buttonLabel: titleText().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("await"),
      title: titleText(),
      description: bodyText().optional(),
      // Spec §10.2 declares `pollMs` required, but a default of 1000 accepts every message
      // a conforming plugin can send (whether or not it sets `pollMs`) plus omission, so it
      // is strictly more permissive than the spec text and never rejects a conforming plugin.
      pollMs: z.number().default(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("done"),
      message: bodyText().optional(),
      config: z.record(z.string(), z.string()).optional(),
      secrets: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      message: bodyText(),
    })
    .strict(),
])
export type FlowStep = z.infer<typeof FlowStepSchema>

export const FlowResultSchema = z.discriminatedUnion("kind", [
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
export type FlowResult = z.infer<typeof FlowResultSchema>

export const FlowToastSchema = z
  .object({
    tone: z.enum(["info", "success", "warning", "error"]),
    message: bodyText(),
  })
  .strict()
export type FlowToast = z.infer<typeof FlowToastSchema>

export const FlowResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    step: FlowStepSchema,
    toast: FlowToastSchema.optional(),
  })
  .strict()
export type FlowResponse = z.infer<typeof FlowResponseSchema>

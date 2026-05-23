import { z } from "zod"
import { type Result, ok, err } from "@launchkit/utils"
import { type NormalizedRequest, type NormalizedMessage, type ProxyError } from "../types"

const OpenAIBody = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })).min(1),
})

export const parseOpenAIRequest = (body: unknown): Result<NormalizedRequest, ProxyError> => {
  const parsed = OpenAIBody.safeParse(body)
  if (!parsed.success) return err({ kind: "bad-request", detail: parsed.error.message })
  const b = parsed.data
  const system = b.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") || undefined
  const messages: NormalizedMessage[] = b.messages
    .filter((m): m is { role: "user" | "assistant"; content: string } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }))
  if (messages.length === 0) return err({ kind: "bad-request", detail: "no user/assistant messages" })
  return ok({
    model: b.model,
    ...(system !== undefined ? { system } : {}),
    ...(b.max_tokens !== undefined ? { maxTokens: b.max_tokens } : {}),
    ...(b.temperature !== undefined ? { temperature: b.temperature } : {}),
    stream: b.stream ?? false,
    messages,
  })
}

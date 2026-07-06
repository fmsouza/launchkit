import { z } from "zod"

/**
 * Attachment capabilities derivable for a provider model: what discovery
 * metadata or name heuristics say it can RECEIVE. Absent key = unknown.
 * Pure vocabulary — persistence and precedence live with the model record.
 */
export type DiscoveredAttachments = {
  readonly image?: boolean
  readonly pdf?: boolean
}

/** Name patterns for models known to accept images. Lowercase substring/regex match. */
const IMAGE_PATTERNS: readonly RegExp[] = [
  /gpt-4o/,
  /gpt-4\.1/,
  /gpt-5/,
  /^o[34]\b/,
  /claude-[34]/,
  /claude-(opus|sonnet|haiku)/,
  /gemini/,
  /llava/,
  /-vl\b|-vl-|vl:|2-vl|2vl/,
  /vision/,
  /pixtral/,
  /minimax-vl/,
]

/** Families with native PDF/document ingestion. Conservative: claude + gemini only. */
const PDF_PATTERNS: readonly RegExp[] = [
  /claude-[34]/,
  /claude-(opus|sonnet|haiku)/,
  /gemini/,
]

/**
 * Best-effort capability guess from the provider-model NAME alone. Returns {}
 * (unknown ⇒ gated off) when no pattern matches — the user override is the
 * escape hatch for false negatives. Pure.
 */
export const heuristicAttachments = (
  providerModel: string,
): DiscoveredAttachments => {
  const name = providerModel.toLowerCase()
  const image = IMAGE_PATTERNS.some((p) => p.test(name))
  const pdf = PDF_PATTERNS.some((p) => p.test(name))
  if (!image && !pdf) return {}
  return { image, ...(pdf ? { pdf } : {}) }
}

// openrouter's /models entries carry architecture.input_modalities; other
// openai-compatible providers usually don't — parse defensively.
const OpenAiEntrySchema = z
  .object({
    architecture: z
      .object({ input_modalities: z.array(z.string()) })
      .partial()
      .passthrough()
      .optional(),
  })
  .passthrough()

/**
 * Extract attachment capabilities from ONE `/models` entry of an
 * openai-compatible discovery response. Returns undefined when the entry
 * carries no modality metadata (⇒ caller falls back to the heuristic). Pure.
 */
export const attachmentsFromOpenAiEntry = (
  entry: unknown,
): DiscoveredAttachments | undefined => {
  const parsed = OpenAiEntrySchema.safeParse(entry)
  if (!parsed.success) return undefined
  const modalities = parsed.data.architecture?.input_modalities
  if (modalities === undefined) return undefined
  return {
    image: modalities.includes("image"),
    pdf: modalities.includes("file") || modalities.includes("pdf"),
  }
}

/** Ollama model families that indicate a vision projector. */
const OLLAMA_VISION_FAMILIES = new Set([
  "clip",
  "mllama",
  "qwen2vl",
  "qwen25vl",
  "gemma3",
  "llava",
])

const OllamaTagSchema = z
  .object({
    details: z
      .object({ families: z.array(z.string()).nullable().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough()

/**
 * Extract attachment capabilities from ONE `/api/tags` entry (the same
 * response ollama discovery already fetches — no extra request). `families`
 * absent ⇒ undefined (heuristic fallback). Ollama has no PDF ingestion. Pure.
 */
export const attachmentsFromOllamaTag = (
  entry: unknown,
): DiscoveredAttachments | undefined => {
  const parsed = OllamaTagSchema.safeParse(entry)
  if (!parsed.success) return undefined
  const families = parsed.data.details?.families
  if (families === undefined || families === null) return undefined
  return {
    image: families.some((f) => OLLAMA_VISION_FAMILIES.has(f.toLowerCase())),
    pdf: false,
  }
}

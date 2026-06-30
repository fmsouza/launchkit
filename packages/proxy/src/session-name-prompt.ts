/** Max chars of the first prompt forwarded to the naming model. Caps prompt cost. */
export const NAME_PROMPT_MAX = 4000

/**
 * The system instruction that asks for a short, concise, topic-identifying
 * session name. PURE — given the user's first prompt, returns the system +
 * user messages for a generateText call. No IO, no model.
 */
export const buildNamePrompt = (
  firstPrompt: string,
): {
  readonly system: string
  readonly user: string
} => ({
  system:
    "You name chat sessions. Reply with ONE short, concise title (≤ 6 words, " +
    "≤ 50 chars) that identifies the topic. Plain text, no quotes, no " +
    "punctuation at the end, no preface, no explanation.",
  user: firstPrompt.slice(0, NAME_PROMPT_MAX),
})

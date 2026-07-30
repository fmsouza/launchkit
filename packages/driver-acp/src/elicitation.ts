import type { QuestionAnswer, QuestionPrompt } from "@spectrum/agent-events"
import type { AcpElicitation } from "./acp-client"

/** What the client answers an `elicitation/create` request with. */
export type AcpElicitationResponse =
  | { readonly action: "accept"; readonly content: Record<string, unknown> }
  | { readonly action: "decline" }

const FALLBACK_PROPERTY = "value"

/** The `properties` map of an elicitation's JSON-Schema, when it has a usable one. */
const properties = (
  elicitation: AcpElicitation,
): Record<string, unknown> | undefined => {
  const schema = elicitation.requestedSchema
  if (typeof schema !== "object" || schema === null) return undefined
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== "object" || props === null) return undefined
  return props as Record<string, unknown>
}

/**
 * The schema property the answer is written under. ACP elicitation schemas are objects, and
 * Spectrum's question card collects ONE answer, so the first property is the one we can fill. Pure.
 */
export const firstPropertyName = (elicitation: AcpElicitation): string => {
  const props = properties(elicitation)
  if (props === undefined) return FALLBACK_PROPERTY
  const [first] = Object.keys(props)
  return first ?? FALLBACK_PROPERTY
}

/** The `enum` values of the first schema property, when it constrains the answer to a choice. */
const enumValues = (elicitation: AcpElicitation): readonly string[] => {
  const props = properties(elicitation)
  if (props === undefined) return []
  const [first] = Object.values(props)
  if (typeof first !== "object" || first === null) return []
  const values = (first as { enum?: unknown }).enum
  if (!Array.isArray(values)) return []
  return values.filter((v): v is string => typeof v === "string")
}

/**
 * Shape an ACP elicitation as a Spectrum question card. One question always: ACP elicitation is a
 * single prompt, and the card's multi-question form is for harnesses that batch them. Pure.
 */
export const elicitationToQuestion = (
  elicitation: AcpElicitation,
): QuestionPrompt => {
  const options = enumValues(elicitation)
  return {
    questions: [
      {
        question: elicitation.message,
        header: "Question",
        options: options.map((label) => ({ label })),
        multiSelect: false,
        // A schema `enum` is a closed set — offering free text would let the user answer something
        // the agent will reject. Without one, free text is the only way to answer.
        allowFreeText: options.length === 0,
      },
    ],
  }
}

/**
 * Turn the user's answer into the elicitation response. A selected label wins over free text; an
 * empty answer DECLINES rather than accepting an empty string, so the agent can take its own
 * fallback path instead of acting on a blank value. Pure.
 */
export const answerToElicitationResponse = (
  answer: QuestionAnswer,
  propertyName: string,
): AcpElicitationResponse => {
  const [selection] = answer.selections
  if (selection === undefined) return { action: "decline" }
  const value = selection.labels[0] ?? selection.freeText
  if (value === undefined || value === "") return { action: "decline" }
  return { action: "accept", content: { [propertyName]: value } }
}

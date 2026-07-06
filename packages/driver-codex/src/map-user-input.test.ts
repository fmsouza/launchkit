import { describe, expect, it } from "bun:test"
import type { ToolRequestUserInputParams } from "./bindings/v2"
import {
  mapAnswerToUserInputResponse,
  mapUserInputParams,
} from "./map-user-input"

const params: ToolRequestUserInputParams = {
  threadId: "t1",
  turnId: "u1",
  itemId: "i1",
  questions: [
    {
      id: "qa",
      header: "Pick",
      question: "Which?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
      ],
    },
  ],
}

describe("mapUserInputParams", () => {
  it("maps codex questions to a QuestionPrompt (isOther → allowFreeText)", () => {
    const prompt = mapUserInputParams(params)
    expect(prompt.questions[0]?.header).toBe("Pick")
    expect(prompt.questions[0]?.allowFreeText).toBe(true)
    expect(prompt.questions[0]?.options.map((o) => o.label)).toEqual(["A", "B"])
  })
  it("treats null options as a free-text question", () => {
    const baseQuestion = params.questions[0]
    if (!baseQuestion) throw new Error("expected a base question")
    const prompt = mapUserInputParams({
      ...params,
      questions: [{ ...baseQuestion, options: null }],
    })
    expect(prompt.questions[0]?.options).toEqual([])
  })
})

describe("mapAnswerToUserInputResponse", () => {
  it("keys answers by the codex question id", () => {
    const res = mapAnswerToUserInputResponse(params, {
      selections: [{ questionIndex: 0, labels: ["A"] }],
    })
    expect(res.answers.qa?.answers).toEqual(["A"])
  })
  it("includes free text in the answers array", () => {
    const res = mapAnswerToUserInputResponse(params, {
      selections: [{ questionIndex: 0, labels: [], freeText: "C" }],
    })
    expect(res.answers.qa?.answers).toEqual(["C"])
  })
})

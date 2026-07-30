import { describe, expect, it } from "bun:test"
import {
  answerToElicitationResponse,
  elicitationToQuestion,
  firstPropertyName,
} from "./elicitation"

describe("elicitationToQuestion", () => {
  it("uses the elicitation message as the question text", () => {
    const prompt = elicitationToQuestion({ message: "Which branch?" })
    expect(prompt.questions[0]?.question).toBe("Which branch?")
  })

  it("offers the enum values of a string property as selectable options", () => {
    const prompt = elicitationToQuestion({
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: { branch: { type: "string", enum: ["main", "dev"] } },
      },
    })
    expect(prompt.questions[0]?.options.map((o) => o.label)).toEqual([
      "main",
      "dev",
    ])
  })

  it("does not allow free text when the schema constrains the answer to an enum", () => {
    const prompt = elicitationToQuestion({
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: { branch: { type: "string", enum: ["main"] } },
      },
    })
    expect(prompt.questions[0]?.allowFreeText).toBe(false)
  })

  it("allows free text when the schema declares no enum", () => {
    const prompt = elicitationToQuestion({ message: "Name it" })
    expect(prompt.questions[0]?.allowFreeText).toBe(true)
    expect(prompt.questions[0]?.options).toEqual([])
  })

  it("never asks more than one question (ACP elicitation is a single prompt)", () => {
    const prompt = elicitationToQuestion({
      message: "Pick",
      requestedSchema: {
        type: "object",
        properties: {
          a: { type: "string", enum: ["x"] },
          b: { type: "string", enum: ["y"] },
        },
      },
    })
    expect(prompt.questions).toHaveLength(1)
  })
})

describe("firstPropertyName", () => {
  it("reads the first property name from the requested schema", () => {
    expect(
      firstPropertyName({
        message: "m",
        requestedSchema: {
          type: "object",
          properties: { branch: { type: "string" } },
        },
      }),
    ).toBe("branch")
  })

  it("falls back to a generic key when the schema is absent", () => {
    expect(firstPropertyName({ message: "m" })).toBe("value")
  })

  it("falls back to a generic key when the schema is malformed", () => {
    expect(
      firstPropertyName({ message: "m", requestedSchema: "not an object" }),
    ).toBe("value")
  })
})

describe("answerToElicitationResponse", () => {
  it("accepts with the selected label keyed by the requested property name", () => {
    expect(
      answerToElicitationResponse(
        { selections: [{ questionIndex: 0, labels: ["main"] }] },
        "branch",
      ),
    ).toEqual({ action: "accept", content: { branch: "main" } })
  })

  it("accepts with the free text when the user typed instead of selecting", () => {
    expect(
      answerToElicitationResponse(
        {
          selections: [{ questionIndex: 0, labels: [], freeText: "release/1" }],
        },
        "branch",
      ),
    ).toEqual({ action: "accept", content: { branch: "release/1" } })
  })

  it("declines when the user answered nothing", () => {
    expect(answerToElicitationResponse({ selections: [] }, "branch")).toEqual({
      action: "decline",
    })
  })

  it("declines when the selection is empty and carries no free text", () => {
    expect(
      answerToElicitationResponse(
        { selections: [{ questionIndex: 0, labels: [] }] },
        "branch",
      ),
    ).toEqual({ action: "decline" })
  })
})

import { describe, expect, it } from "bun:test"
import {
  FlowResultViewSchema,
  FlowStepViewSchema,
  FlowToastViewSchema,
} from "./flow-view"

describe("FlowStepViewSchema", () => {
  it("accepts a sanitized done step carrying only a message", () => {
    expect(
      FlowStepViewSchema.safeParse({ kind: "done", message: "Signed in" })
        .success,
    ).toBe(true)
  })

  it("accepts a done step carrying nothing at all", () => {
    expect(FlowStepViewSchema.safeParse({ kind: "done" }).success).toBe(true)
  })

  it("rejects a done step carrying secrets", () => {
    expect(
      FlowStepViewSchema.safeParse({
        kind: "done",
        secrets: { apiKey: "sk" },
      }).success,
    ).toBe(false)
  })

  it("rejects a done step carrying config", () => {
    expect(
      FlowStepViewSchema.safeParse({
        kind: "done",
        config: { serverUrl: "http://x" },
      }).success,
    ).toBe(false)
  })

  it("still accepts a form step unchanged", () => {
    expect(
      FlowStepViewSchema.safeParse({
        kind: "form",
        title: "Sign in",
        fields: [
          { name: "token", label: "Token", kind: "password", required: true },
        ],
      }).success,
    ).toBe(true)
  })

  it("rejects an open-external step whose url is not http or https", () => {
    expect(
      FlowStepViewSchema.safeParse({
        kind: "open-external",
        title: "Go",
        url: "file:///etc/passwd",
      }).success,
    ).toBe(false)
  })

  it("rejects a select field that declares no options", () => {
    expect(
      FlowStepViewSchema.safeParse({
        kind: "form",
        title: "Pick",
        fields: [
          { name: "region", label: "Region", kind: "select", required: true },
        ],
      }).success,
    ).toBe(false)
  })

  it("fills an await step's poll interval when the step omits it", () => {
    const parsed = FlowStepViewSchema.safeParse({
      kind: "await",
      title: "Waiting",
    })
    expect(parsed.success && parsed.data).toEqual({
      kind: "await",
      title: "Waiting",
      pollMs: 1000,
    })
  })

  it("rejects a message step carrying an unknown field", () => {
    expect(
      FlowStepViewSchema.safeParse({
        kind: "message",
        title: "Hi",
        body: "b",
        tone: "info",
        hostToken: "t",
      }).success,
    ).toBe(false)
  })
})

describe("FlowResultViewSchema", () => {
  it("accepts a form submission carrying the entered values", () => {
    expect(
      FlowResultViewSchema.safeParse({
        kind: "form",
        values: { token: "sk-1" },
      }).success,
    ).toBe(true)
  })

  it("accepts a poll result", () => {
    expect(FlowResultViewSchema.safeParse({ kind: "poll" }).success).toBe(true)
  })

  it("rejects a result kind the flow protocol does not define", () => {
    expect(FlowResultViewSchema.safeParse({ kind: "resume" }).success).toBe(
      false,
    )
  })
})

describe("FlowToastViewSchema", () => {
  it("accepts an error-toned toast", () => {
    expect(
      FlowToastViewSchema.safeParse({ tone: "error", message: "nope" }).success,
    ).toBe(true)
  })

  it("rejects a toast carrying an unknown field", () => {
    expect(
      FlowToastViewSchema.safeParse({
        tone: "info",
        message: "hi",
        secrets: { a: "b" },
      }).success,
    ).toBe(false)
  })
})

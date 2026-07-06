import { describe, expect, it } from "bun:test"
import {
  attachmentsFromOllamaTag,
  attachmentsFromOpenAiEntry,
  heuristicAttachments,
} from "./attachment-capabilities"

describe("heuristicAttachments", () => {
  it("marks known vision families as image-capable", () => {
    for (const name of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "o3",
      "gemini-2.5-pro",
      "llava:13b",
      "qwen2-vl-7b",
      "pixtral-large",
      "minimax-vl-01",
      "llama3.2-vision",
    ]) {
      expect(heuristicAttachments(name).image).toBe(true)
    }
  })

  it("marks claude and gemini families as pdf-capable", () => {
    expect(heuristicAttachments("claude-sonnet-4-5").pdf).toBe(true)
    expect(heuristicAttachments("gemini-2.5-flash").pdf).toBe(true)
    expect(heuristicAttachments("gpt-4o").pdf).toBeUndefined()
  })

  it("returns {} (unknown) for unrecognized names", () => {
    expect(heuristicAttachments("kimi-k2.7-code")).toEqual({})
    expect(heuristicAttachments("minimax-m3")).toEqual({})
  })
})

describe("attachmentsFromOpenAiEntry", () => {
  it("reads openrouter-style architecture.input_modalities", () => {
    expect(
      attachmentsFromOpenAiEntry({
        id: "openai/gpt-4o",
        architecture: { input_modalities: ["text", "image"] },
      }),
    ).toEqual({ image: true, pdf: false })
    expect(
      attachmentsFromOpenAiEntry({
        id: "deepseek/deepseek-r1",
        architecture: { input_modalities: ["text"] },
      }),
    ).toEqual({ image: false, pdf: false })
  })

  it("reads file modality as pdf capability", () => {
    expect(
      attachmentsFromOpenAiEntry({
        id: "google/gemini-2.5-pro",
        architecture: { input_modalities: ["text", "image", "file"] },
      }),
    ).toEqual({ image: true, pdf: true })
  })

  it("returns undefined when the entry has no modality metadata", () => {
    expect(attachmentsFromOpenAiEntry({ id: "gpt-4o" })).toBeUndefined()
    expect(attachmentsFromOpenAiEntry("nonsense")).toBeUndefined()
  })
})

describe("attachmentsFromOllamaTag", () => {
  it("marks vision families from details.families", () => {
    expect(
      attachmentsFromOllamaTag({
        name: "llava:13b",
        details: { families: ["llama", "clip"] },
      }),
    ).toEqual({ image: true, pdf: false })
    expect(
      attachmentsFromOllamaTag({
        name: "qwen2-vl",
        details: { families: ["qwen2vl"] },
      }),
    ).toEqual({ image: true, pdf: false })
  })

  it("marks text-only families as image:false", () => {
    expect(
      attachmentsFromOllamaTag({
        name: "llama3:8b",
        details: { families: ["llama"] },
      }),
    ).toEqual({ image: false, pdf: false })
  })

  it("returns undefined when families are absent", () => {
    expect(attachmentsFromOllamaTag({ name: "mystery" })).toBeUndefined()
    expect(attachmentsFromOllamaTag(42)).toBeUndefined()
  })
})

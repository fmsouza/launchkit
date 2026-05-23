import { describe, expect, it } from "bun:test"
import * as harnesses from "./index"

describe("@launchkit/harnesses barrel", () => {
  it("exports the four built-ins and the builtinHarnesses list", () => {
    for (const name of [
      "claude",
      "codex",
      "opencode",
      "openclaw",
      "builtinHarnesses",
    ]) {
      expect(harnesses).toHaveProperty(name)
    }
  })

  it("exports the validators, registry, and launcher", () => {
    for (const name of [
      "ALLOWED_TOKENS",
      "validateEnvTemplate",
      "createRegistry",
      "launchHarness",
    ]) {
      expect(harnesses).toHaveProperty(name)
    }
  })

  it("exports the real adapters", () => {
    for (const name of [
      "createPathCommandResolver",
      "createBunProcessSpawner",
      "createDirHarnessFileSource",
    ]) {
      expect(harnesses).toHaveProperty(name)
    }
  })

  it("exports the in-memory fakes for testing downstream packages", () => {
    for (const name of [
      "createInMemoryHarnessFileSource",
      "createFakeCommandResolver",
      "createRecordingProcessSpawner",
    ]) {
      expect(harnesses).toHaveProperty(name)
    }
  })

  it("exposes ALLOWED_TOKENS as the three proxy tokens", () => {
    expect(harnesses.ALLOWED_TOKENS).toEqual(["proxyUrl", "proxyKey", "model"])
  })
})

import { describe, expect, it } from "bun:test"
import type { Logger } from "@spectrum/logger"
import { err } from "@spectrum/utils"
import type { ConfigFile } from "./file"
import { createInMemoryConfigFile } from "./file"
import { CURRENT_CONFIG_VERSION, defaultConfig } from "./schema"
import { createFileConfigStore } from "./store"

type Captured = { msg: string; fields?: Record<string, unknown> | undefined }

const makeFakeLogger = (): { logger: Logger; errors: Captured[] } => {
  const errors: Captured[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg, fields) => {
      errors.push({ msg, fields })
    },
    fatal: () => {},
    child: () => logger,
  }
  return { logger, errors }
}

describe("createFileConfigStore.load", () => {
  it("returns factory defaults when the file does not exist", async () => {
    const store = createFileConfigStore({ file: createInMemoryConfigFile() })
    const result = await store.load()
    expect(result).toEqual({ ok: true, value: defaultConfig() })
  })

  it("loads, migrates, and validates an existing v1 file into a current Config", async () => {
    const v1OnDisk = JSON.stringify({
      version: 1,
      providers: [
        {
          id: "p_openai",
          name: "OpenAI",
          sdkProvider: "openai",
          apiKey: "sk-legacy",
          config: {},
          models: ["gpt-4o"],
        },
      ],
      aliases: [],
    })
    const store = createFileConfigStore({
      file: createInMemoryConfigFile(v1OnDisk),
    })

    const result = await store.load()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(CURRENT_CONFIG_VERSION)
    expect(result.value.providers[0]?.secrets).toEqual({})
  })

  it("returns parse-failed when the file contains invalid JSON", async () => {
    const store = createFileConfigStore({
      file: createInMemoryConfigFile("{ not json"),
    })
    const result = await store.load()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("parse-failed")
  })

  it("returns migration-failed when the parsed JSON has a future version", async () => {
    const onDisk = JSON.stringify({
      version: 999,
      providers: [],
      aliases: [],
      settings: {},
    })
    const store = createFileConfigStore({
      file: createInMemoryConfigFile(onDisk),
    })
    const result = await store.load()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("migration-failed")
  })
})

describe("createFileConfigStore logging", () => {
  it("logs an error with { kind, detail } when load fails to parse", async () => {
    const { logger, errors } = makeFakeLogger()
    const store = createFileConfigStore({
      file: createInMemoryConfigFile("{ not json"),
      logger,
    })

    await store.load()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.fields?.kind).toBe("parse-failed")
    expect(typeof errors[0]?.fields?.detail).toBe("string")
  })

  it("logs an error with { kind, detail } when migration fails", async () => {
    const { logger, errors } = makeFakeLogger()
    const onDisk = JSON.stringify({
      version: 999,
      providers: [],
      aliases: [],
      settings: {},
    })
    const store = createFileConfigStore({
      file: createInMemoryConfigFile(onDisk),
      logger,
    })

    await store.load()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.fields?.kind).toBe("migration-failed")
    expect(typeof errors[0]?.fields?.detail).toBe("string")
  })

  it("logs an error with { kind, detail } when the file read fails", async () => {
    const { logger, errors } = makeFakeLogger()
    const failingFile: ConfigFile = {
      exists: async () => true,
      read: async () => err({ kind: "parse-failed", detail: "disk on fire" }),
      writeAtomic: async () => ({ ok: true, value: undefined }),
    }
    const store = createFileConfigStore({ file: failingFile, logger })

    await store.load()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.fields?.kind).toBe("parse-failed")
    expect(errors[0]?.fields?.detail).toBe("disk on fire")
  })

  it("logs an error with { kind, detail } when save fails to write", async () => {
    const { logger, errors } = makeFakeLogger()
    const failingFile: ConfigFile = {
      exists: async () => true,
      read: async () => ({ ok: true, value: "{}" }),
      writeAtomic: async () =>
        err({ kind: "write-failed", detail: "no space" }),
    }
    const store = createFileConfigStore({ file: failingFile, logger })

    await store.save(defaultConfig())

    expect(errors).toHaveLength(1)
    expect(errors[0]?.fields?.kind).toBe("write-failed")
    expect(errors[0]?.fields?.detail).toBe("no space")
  })

  it("does not log when load and save succeed", async () => {
    const { logger, errors } = makeFakeLogger()
    const store = createFileConfigStore({
      file: createInMemoryConfigFile(),
      logger,
    })

    await store.load()
    await store.save(defaultConfig())

    expect(errors).toHaveLength(0)
  })
})

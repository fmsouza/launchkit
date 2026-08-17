import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMemoryWriter, runCli } from "@spectrum/cli"
import {
  type Config,
  createCachedConfigStore,
  createFileConfigStore,
  createFsConfigFile,
  exportConfig,
} from "@spectrum/config"
import { builtinHarnesses } from "@spectrum/harnesses"
import { createNoopLogger } from "@spectrum/logger"

const dirs: string[] = []

const freshConfig = async (): Promise<{
  store: ReturnType<typeof createCachedConfigStore>
  path: string
}> => {
  const dir = await mkdtemp(join(tmpdir(), "spectrum-cli-e2e-"))
  dirs.push(dir)
  const path = join(dir, "config.json")
  const config: Config = {
    version: 2,
    providers: [
      {
        id: "p1",
        name: "Local",
        sdkProvider: "openai",
        config: {},
        secrets: {},
        models: ["gpt-4o"],
      },
    ],
    models: [{ id: "mdl_default", providerId: "p1", providerModel: "gpt-4o" }],
    settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    providerPlugins: [],
  } as unknown as Config
  await writeFile(path, exportConfig(config), "utf8")
  return {
    store: createCachedConfigStore(
      createFileConfigStore({ file: createFsConfigFile(path) }),
    ),
    path,
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

// End-to-end CLI paths over fakes; platform-agnostic — run everywhere, including Linux CI.
describe("spectrum-cli end-to-end", () => {
  it("runs `list harnesses` against a temp config and prints the built-in ids", async () => {
    const { store } = await freshConfig()
    const out = createMemoryWriter()
    const deps = {
      config: store,
      secrets: {
        set: async () => ({ ok: true, value: { ref: "kc" } }),
        get: async () => ({ ok: true, value: "x" }),
        delete: async () => ({ ok: true, value: undefined }),
        has: async () => false,
      },
      sessions: {
        init: () => ({ ok: true, value: undefined }),
        create: () => ({ ok: true, value: {} }),
        close: () => ({ ok: true, value: {} }),
        query: () => ({ ok: true, value: [] }),
      },
      projects: {
        findOrCreate: async () => ({ ok: true, value: { id: "p" } }),
        list: async () => ({ ok: true, value: [] }),
      },
      runtime: {
        readProxyKey: async () => null,
        writeProxyKey: async () => ({ ok: true, value: undefined }),
        clear: async () => {},
      },
      registry: {
        list: async () => ({ ok: true as const, value: builtinHarnesses }),
      },
      launch: () => ({
        ok: true as const,
        value: { pid: 1, exited: Promise.resolve(0) },
      }),
      proxy: {
        isRunning: async () => false,
        start: () => ({
          hostname: "127.0.0.1",
          port: 0,
          stop: () => {},
        }),
      },
      genProxyKey: () => "k",
      logger: createNoopLogger(),
      out,
    } as never

    const result = await runCli(deps)(["list", "harnesses"])

    expect(result.ok).toBe(true)
    expect(out.lines.join("\n")).toContain("claude")
  })
})

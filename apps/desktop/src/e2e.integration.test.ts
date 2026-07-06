import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Config,
  createCachedConfigStore,
  createFileConfigStore,
  createFsConfigFile,
  exportConfig,
} from "@spectrum/config"
import {
  createInMemoryHarnessFileSource,
  createRegistry,
} from "@spectrum/harnesses"
import {
  type LanguageModelGateway,
  createRouter,
  createScriptedGateway,
  isProxyRunning,
  startProxy,
} from "@spectrum/proxy"
import { buildTrayMenu } from "./gui/tray-menu"

const dirs: string[] = []

const freshConfig = async (): Promise<{
  store: ReturnType<typeof createCachedConfigStore>
  path: string
}> => {
  const dir = await mkdtemp(join(tmpdir(), "spectrum-e2e-"))
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
  } as Config
  await writeFile(path, exportConfig(config), "utf8")
  return {
    store: createCachedConfigStore(
      createFileConfigStore({ file: createFsConfigFile(path) }),
    ),
    path,
  }
}

let stopProxy: (() => void) | undefined
afterEach(async () => {
  stopProxy?.()
  stopProxy = undefined
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

// These end-to-end paths (CLI over fakes, a real loopback proxy on an ephemeral port, the pure
// tray-menu descriptor) are platform-agnostic — run them everywhere, including Linux CI.
describe("Spectrum end-to-end", () => {
  it("answers /health from a real loopback proxy on an ephemeral port", async () => {
    const { store } = await freshConfig()
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const running = startProxy({
      host: "127.0.0.1",
      port: 0,
      proxyKey: "k",
      router: createRouter(loaded.value),
      factory: {
        getModel: async () => ({ ok: true, value: {} }),
        getModelFromResolved: async () => ({ ok: true, value: {} }),
      },
      gateway: createScriptedGateway([
        { type: "finish", finishReason: "stop" },
      ]),
      listModels: () => loaded.value.models.map((m) => String(m.id)),
    })
    stopProxy = running.stop

    expect(running.hostname).toBe("127.0.0.1")
    expect(await isProxyRunning(`http://127.0.0.1:${running.port}`)).toBe(true)
  })

  it("keeps a slow stream open past the old 10s idle timeout (idleTimeout disabled)", async () => {
    const cfg = {
      version: 4,
      providers: [
        {
          id: "p1",
          name: "x",
          sdkProvider: "openai",
          config: {},
          secrets: {},
          models: [],
        },
      ],
      models: [
        { id: "mdl_default", providerId: "p1", providerModel: "gpt-4o" },
      ],
      settings: { proxyPort: 4000, proxyHost: "127.0.0.1" },
    } as unknown as Config

    // A slow model: nothing for 10.5s (longer than Bun's old default idleTimeout), then a token.
    // Regression guard for "The socket connection was closed unexpectedly" — the proxy must not drop
    // the idle socket while the model is thinking.
    const slow: LanguageModelGateway = {
      async *stream() {
        await new Promise((r) => setTimeout(r, 10_500))
        yield { type: "text-delta", text: "ok" }
        yield { type: "finish", finishReason: "stop" }
      },
    }
    const running = startProxy({
      host: "127.0.0.1",
      port: 0,
      proxyKey: "k",
      router: createRouter(cfg),
      factory: {
        getModel: async () => ({ ok: true, value: {} }),
        getModelFromResolved: async () => ({ ok: true, value: {} }),
      },
      gateway: slow,
      listModels: () => cfg.models.map((m) => String(m.id)),
    })
    stopProxy = running.stop
    const res = await fetch(`http://127.0.0.1:${running.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({
        model: "mdl_default",
        max_tokens: 1,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const body = await res.text() // would throw / truncate if the socket were dropped at 10s
    expect(body).toContain("message_stop")
  }, 20_000)

  it("a running proxy with a live config getter reflects a model saved after startup (no restart)", async () => {
    const { store } = await freshConfig()
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    // Mirror the desktop composition: keep a live snapshot updated on save and resolve against it on
    // every request, so a model added in the GUI (persisted via config.save) is picked up without a
    // restart. Guards against regressing back to a frozen start-time config snapshot.
    let liveConfig: Config = loaded.value
    const save = async (c: Config): Promise<void> => {
      const r = await store.save(c)
      if (r.ok) liveConfig = c
    }
    const getConfig = (): Config => liveConfig

    const running = startProxy({
      host: "127.0.0.1",
      port: 0,
      proxyKey: "k",
      router: createRouter(getConfig),
      factory: {
        getModel: async () => ({ ok: true, value: {} }),
        getModelFromResolved: async () => ({ ok: true, value: {} }),
      },
      gateway: createScriptedGateway([
        { type: "finish", finishReason: "stop" },
      ]),
      listModels: () => getConfig().models.map((m) => String(m.id)),
    })
    stopProxy = running.stop
    const base = `http://127.0.0.1:${running.port}`
    const ids = async (): Promise<string[]> => {
      const res = await fetch(`${base}/v1/models`, {
        headers: { "x-api-key": "k" },
      })
      const json = (await res.json()) as { data: { id: string }[] }
      return json.data.map((m) => m.id)
    }

    expect(await ids()).not.toContain("mdl_added")
    await save({
      ...liveConfig,
      models: [
        ...liveConfig.models,
        { id: "mdl_added", providerId: "p1", providerModel: "gpt-4o" } as never,
      ],
    })
    // No restart, no rebuild — the running proxy already reflects the saved model.
    expect(await ids()).toContain("mdl_added")
  })

  it("builds a tray menu reflecting the configured harnesses and proxy status", async () => {
    const registry = createRegistry({
      fileSource: createInMemoryHarnessFileSource([]),
    })
    const listed = await registry.list()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return

    const menu = buildTrayMenu({
      harnesses: listed.value,
      proxyRunning: true,
    })

    expect(menu.items[0]).toMatchObject({
      kind: "status",
      dot: { state: "on", color: "green" },
    })
    const submenu = menu.items.find((i) => i.kind === "submenu")
    expect(
      submenu?.kind === "submenu" &&
        submenu.items.map((i) => (i.kind === "launch" ? i.harnessId : i.kind)),
    ).toContain("claude")
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDirExtensionFileSource,
  createExtensionRegistry,
} from "@spectrum/extensions"
import {
  createBunProcessSpawner,
  createPathCommandResolver,
} from "@spectrum/proc"
import {
  type ProviderHost,
  createCryptoTokenGen,
  createFetchHealthProbe,
  createLoopbackPortAllocator,
  createProviderHost,
} from "@spectrum/provider-host"
import type { ProviderDescriptor } from "@spectrum/providers"
import {
  type LanguageModelGateway,
  type ProviderFactory,
  type ResolveBaseUrl,
  createFetchHttpGet,
  createModelLister,
  createProviderFactory,
  createRealGateway,
  loadSdk,
} from "@spectrum/proxy"
import type { SecretStore } from "@spectrum/secrets"
import { type Provider, ProviderIdSchema, pluginIdOf } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"

/**
 * The whole extension-provider stack against a REAL child process: a hand-written manifest on
 * disk → the file source + registry → the provider host (real spawner, real loopback port, real
 * readiness probe over fetch) → the proxy's provider factory and streaming gateway.
 *
 * Everything below the manifest is production code with production adapters. The only fixture is
 * the plugin itself (`fixtures/echo-openai-server.ts`), which stands in for a shipped plugin's
 * provider server.
 */

const FIXTURE = join(import.meta.dir, "fixtures", "echo-openai-server.ts")

/** A provider contribution manifest, as a plugin author would hand-write it. */
const manifestFor = (id: string, tokenTemplate: string): unknown => ({
  apiVersion: "spectrum.dev/v1",
  id,
  name: `Echo (${id})`,
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id,
        descriptor: {
          label: `Echo ${id}`,
          reasoning: { shape: "none", supportedTiers: [] },
          discovery: { strategy: "openai-models" },
        },
        transport: {
          kind: "http",
          wire: "openai",
          launch: {
            command: process.execPath,
            args: [FIXTURE, "--port", "{{port}}"],
            envTemplate: { SPECTRUM_TOKEN: tokenTemplate },
            // Root-relative: the host hands the factory a bare `http://127.0.0.1:<port>`.
            healthPath: "/models",
            // Long enough for a cold `bun <file>` start on CI; only the happy path waits on it.
            readyTimeoutMs: 20_000,
          },
        },
      },
    ],
  },
})

/**
 * The bad-token twin never becomes ready, so its readiness wait is the test's runtime floor —
 * keep it short enough to stay well inside the case's own timeout.
 */
const BAD_TOKEN_READY_TIMEOUT_MS = 1500

const writeExtension = async (
  root: string,
  id: string,
  manifest: unknown,
): Promise<void> => {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "spectrum-extension.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  )
}

/** No secret refs are configured in these cases, so nothing ever reads through this. */
const unusedSecretStore: SecretStore = {
  set: async () =>
    err({
      kind: "unavailable",
      detail: "no secrets are configured in this test",
    }),
  get: async () =>
    err({
      kind: "unavailable",
      detail: "no secrets are configured in this test",
    }),
  delete: async () =>
    err({
      kind: "unavailable",
      detail: "no secrets are configured in this test",
    }),
  has: async () => false,
}

let tmpRoot = ""
let pluginRoot = ""
let host: ProviderHost
let factory: ProviderFactory
let gateway: LanguageModelGateway
let descriptors: readonly ProviderDescriptor[] = []

const descriptorFor = (id: string): ProviderDescriptor => {
  const found = descriptors.find((d) => pluginIdOf(String(d.key)) === id)
  if (found === undefined)
    throw new Error(`no descriptor contributed for ${id}`)
  return found
}

const providerFor = (descriptor: ProviderDescriptor): Provider => ({
  id: ProviderIdSchema.parse(`provider-${descriptor.key}`),
  name: descriptor.label,
  sdkProvider: String(descriptor.key),
  config: {},
  secrets: {},
  models: ["echo-1"],
})

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "spectrum-extension-e2e-"))
  pluginRoot = join(tmpRoot, "providers")

  await writeExtension(pluginRoot, "echo", manifestFor("echo", "{{hostToken}}"))

  // Same manifest, except the env template maps the token to a LITERAL: the fixture then echoes
  // a token Spectrum never minted, which is exactly the port-squatter shape readiness rejects.
  const bad = manifestFor("echo-bad", "not-the-host-token") as {
    contributes: {
      providers: { transport: { launch: { readyTimeoutMs: number } } }[]
    }
  }
  const badLaunch = bad.contributes.providers[0]?.transport.launch
  if (badLaunch !== undefined)
    badLaunch.readyTimeoutMs = BAD_TOKEN_READY_TIMEOUT_MS
  await writeExtension(pluginRoot, "echo-bad", bad)

  const registry = createExtensionRegistry({
    fileSource: createDirExtensionFileSource(pluginRoot, {}),
  })

  host = createProviderHost({
    registry,
    resolver: createPathCommandResolver(),
    spawner: createBunProcessSpawner(),
    allocator: createLoopbackPortAllocator(),
    probe: createFetchHealthProbe(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    tokenGen: createCryptoTokenGen(),
  })

  const listed = await registry.providerDescriptors(["echo", "echo-bad"])
  if (!listed.ok)
    throw new Error(`descriptors unavailable: ${listed.error.kind}`)
  descriptors = listed.value

  const getDescriptor = (key: string): ProviderDescriptor | undefined =>
    descriptors.find((d) => d.key === key)

  // Mirrors the composition root's supervised branch: a plugin-keyed descriptor resolves to the
  // live loopback port of its supervised process, started on demand.
  const resolveBaseUrl: ResolveBaseUrl = async (input) => {
    const id = pluginIdOf(String(input.descriptor.key))
    if (id === undefined || input.instanceKey === undefined)
      return ok(undefined)
    const running = await host.ensureRunning({
      instanceKey: input.instanceKey,
      providerId: id,
      secrets: input.secrets,
    })
    if (!running.ok)
      return err({
        kind: "provider-failed",
        detail: `extension ${id} not running`,
      })
    return ok(running.value.baseUrl)
  }

  factory = createProviderFactory({
    secretStore: unusedSecretStore,
    loadSdk,
    getDescriptor,
    resolveBaseUrl,
  })
  gateway = createRealGateway()
})

// UNCONDITIONAL: a failing assertion must never leave a spawned plugin process behind.
afterEach(async () => {
  await host.stopAll()
})

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("extension-contributed provider, end to end", () => {
  it("streams a completion end to end when an extension provider is enabled", async () => {
    const running = await host.ensureRunning({
      instanceKey: "e2e",
      providerId: "echo",
      secrets: {},
    })
    expect(running.ok).toBe(true)

    const descriptor = descriptorFor("echo")
    const model = await factory.getModel(providerFor(descriptor), "echo-1")
    expect(model.ok).toBe(true)
    if (!model.ok) return

    const chunks: string[] = []
    for await (const event of gateway.stream(
      model.value,
      {
        model: "echo-1",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      },
      { descriptor, providerModel: "echo-1" },
    )) {
      if (event.type === "text-delta") chunks.push(event.text)
      if (event.type === "error")
        throw new Error(`gateway error: ${event.detail}`)
    }

    expect(chunks.join("")).toContain("hello")
  }, 30_000)

  it("discovers the fixture model through the contribution's discovery strategy", async () => {
    const running = await host.ensureRunning({
      instanceKey: "discovery",
      providerId: "echo",
      secrets: {},
    })
    expect(running.ok).toBe(true)
    if (!running.ok) return

    const descriptor = descriptorFor("echo")
    const lister = createModelLister({
      httpGet: createFetchHttpGet(),
      getDescriptor: (key: string) =>
        key === descriptor.key ? descriptor : undefined,
    })

    const models = await lister({
      sdkProvider: String(descriptor.key),
      config: { serverUrl: running.value.baseUrl },
    })
    expect(models.ok).toBe(true)
    if (!models.ok) return
    expect(models.value.map((m) => m.id)).toEqual(["echo-1"])
  }, 30_000)

  it("refuses to become ready when the fixture echoes the wrong host token", async () => {
    const running = await host.ensureRunning({
      instanceKey: "bad",
      providerId: "echo-bad",
      secrets: {},
    })
    expect(running.ok).toBe(false)
    expect(host.status("bad")).toBe("failed")
  }, 30_000)
})

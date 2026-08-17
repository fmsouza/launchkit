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

/** Long enough for a cold `bun <file>` start on a loaded CI machine. */
const READY_TIMEOUT_MS = 20_000

/**
 * The wrong-token twin never becomes ready, so its readiness wait IS the case's runtime. It can be
 * shorter than the happy path's without weakening the assertion, because the case does not infer
 * the reason for the refusal from the clock: the fixture writes a marker the first time it answers
 * a health request, so the test proves Spectrum's probe was served before asserting the refusal.
 */
const BAD_TOKEN_READY_TIMEOUT_MS = 5000

/**
 * A provider contribution manifest, as a plugin author would hand-write it.
 *
 * `readyTimeoutMs` is an explicit parameter rather than a post-hoc patch: a cast-and-mutate would
 * silently skip the override if the manifest shape ever drifted, quietly turning the wrong-token
 * case into a 20 s wait instead of failing loudly.
 */
const manifestFor = (input: {
  readonly id: string
  readonly tokenTemplate: string
  readonly readyTimeoutMs: number
}): unknown => ({
  apiVersion: "spectrum.dev/v1",
  id: input.id,
  name: `Echo (${input.id})`,
  version: "1.0.0",
  contributes: {
    providers: [
      {
        id: input.id,
        descriptor: {
          label: `Echo ${input.id}`,
          // Declared so `{{readyMarker}}` is a legal template token: the host renders template
          // values from the SECRETS it is handed plus the runtime facts, and this fixture needs a
          // path to touch. A real plugin would use the same mechanism for an api key.
          secretFields: [
            {
              name: "readyMarker",
              label: "Ready marker path",
              required: false,
            },
          ],
          reasoning: { shape: "none", supportedTiers: [] },
          discovery: { strategy: "openai-models" },
        },
        transport: {
          kind: "http",
          wire: "openai",
          launch: {
            command: process.execPath,
            args: [FIXTURE, "--port", "{{port}}"],
            envTemplate: {
              SPECTRUM_TOKEN: input.tokenTemplate,
              SPECTRUM_READY_MARKER: "{{readyMarker}}",
            },
            // Root-relative: the host hands the factory a bare `http://127.0.0.1:<port>`.
            healthPath: "/models",
            readyTimeoutMs: input.readyTimeoutMs,
          },
        },
      },
    ],
  },
})

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
/** The ONE supervision seam, shared by the factory and the model lister exactly as production shares it. */
let listerResolveBaseUrl: ResolveBaseUrl

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

  await writeExtension(
    pluginRoot,
    "echo",
    manifestFor({
      id: "echo",
      tokenTemplate: "{{hostToken}}",
      readyTimeoutMs: READY_TIMEOUT_MS,
    }),
  )

  // Same manifest, except the env template maps the token to a LITERAL: the fixture then echoes
  // a token Spectrum never minted, which is exactly the port-squatter shape readiness rejects.
  await writeExtension(
    pluginRoot,
    "echo-bad",
    manifestFor({
      id: "echo-bad",
      tokenTemplate: "not-the-host-token",
      readyTimeoutMs: BAD_TOKEN_READY_TIMEOUT_MS,
    }),
  )

  const registry = createExtensionRegistry({
    fileSource: createDirExtensionFileSource(pluginRoot, {}),
  })

  host = createProviderHost({
    registry,
    // Both fixture extensions are enabled in this scenario's config.
    isEnabled: (id: string) => id === "echo" || id === "echo-bad",
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
  listerResolveBaseUrl = resolveBaseUrl

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

  it("discovers the fixture model by starting the supervised process through the seam", async () => {
    // NOTHING is started by hand and NO `serverUrl` is configured — production supplies neither
    // for a supervised plugin, whose port is dynamic. The seam is the only route to a base url,
    // so a lister that computed its own would find nothing to reach.
    const descriptor = descriptorFor("echo")
    const lister = createModelLister({
      httpGet: createFetchHttpGet(),
      getDescriptor: (key: string) =>
        key === descriptor.key ? descriptor : undefined,
      resolveBaseUrl: listerResolveBaseUrl,
    })

    const models = await lister({
      sdkProvider: String(descriptor.key),
      config: {},
      secrets: {},
      instanceKey: "discovery",
    })
    expect(models.ok).toBe(true)
    if (!models.ok) return
    expect(models.value.map((m) => m.id)).toEqual(["echo-1"])
    expect(host.status("discovery")).toBe("running")
  }, 30_000)

  it("refuses to become ready when the fixture echoes the wrong host token", async () => {
    // The host returns the SAME `write-failed / failed readiness` error whether the token
    // mismatched or the process never bound, so the refusal alone proves nothing. The marker is
    // written by the fixture the first time it ANSWERS a health request: its existence means
    // Spectrum's probe reached a live server and got a reply, leaving the token as the only
    // possible reason for the refusal.
    const marker = join(tmpRoot, "bad-probed.marker")

    const running = await host.ensureRunning({
      instanceKey: "bad",
      providerId: "echo-bad",
      secrets: { readyMarker: marker },
    })

    expect(await Bun.file(marker).exists()).toBe(true)
    expect(running.ok).toBe(false)
    expect(host.status("bad")).toBe("failed")
  }, 30_000)
})

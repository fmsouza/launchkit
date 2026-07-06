import { describe, expect, it } from "bun:test"
import type { Logger } from "@spectrum/logger"
import {
  type HarnessDefinition,
  HarnessIdSchema,
  ModelIdSchema,
} from "@spectrum/types"
import { type Result, err, isOk } from "@spectrum/utils"
import { claude as claudeBuiltin } from "./builtin"
import {
  type CommandResolver,
  createFakeCommandResolver,
} from "./command-resolver"
import type { HarnessError } from "./errors"
import { launchHarness, resolveHarnessLaunch } from "./launch"
import type { ProcessSpawner, SpawnedProcess } from "./process-spawner"
import { createRecordingProcessSpawner } from "./process-spawner"

/** Records every call so a test can assert which level + fields a failure logged. */
interface FakeLogger extends Logger {
  readonly records: ReadonlyArray<{
    readonly level: "warn" | "error"
    readonly msg: string
    readonly fields?: Record<string, unknown>
  }>
}

const createFakeLogger = (): FakeLogger => {
  const records: {
    level: "warn" | "error"
    msg: string
    fields?: Record<string, unknown>
  }[] = []
  const self: FakeLogger = {
    records,
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      records.push({ level: "warn", msg, ...(fields ? { fields } : {}) })
    },
    error: (msg, fields) => {
      records.push({ level: "error", msg, ...(fields ? { fields } : {}) })
    },
    fatal: () => {},
    child: () => self,
  }
  return self
}

const claude: HarnessDefinition = {
  id: HarnessIdSchema.parse("claude"),
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: {
    ANTHROPIC_BASE_URL: "{{proxyUrl}}",
    ANTHROPIC_API_KEY: "{{proxyKey}}",
    ANTHROPIC_MODEL: "{{model}}",
  },
  builtIn: true,
}

const proxiedRoute = {
  kind: "proxied",
  proxyUrl: "http://127.0.0.1:4000",
  proxyKey: "k-secret",
  modelId: ModelIdSchema.parse("mdl_x"),
} as const

const params = {
  harness: claude,
  route: proxiedRoute,
}

describe("launchHarness", () => {
  it("spawns the resolved absolute command with an empty args array and rendered env", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const spawner = createRecordingProcessSpawner(999)

    const r = launchHarness({ resolver, spawner })(params)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.pid).toBe(999)
    expect(spawner.calls).toHaveLength(1)
    const call = spawner.calls[0]
    expect(call?.command).toBe("/usr/local/bin/claude")
    expect(Array.isArray(call?.args)).toBe(true)
    expect(call?.args).toEqual([])
    expect(call?.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
      ANTHROPIC_API_KEY: "k-secret",
      ANTHROPIC_MODEL: "mdl_x",
    })
  })

  it("renders argsTemplate tokens into the spawn args in proxied mode (codex provider flags)", () => {
    const codexLike: HarnessDefinition = {
      id: HarnessIdSchema.parse("codex"),
      name: "Codex",
      command: "codex",
      apiFormat: "openai",
      envTemplate: { OPENAI_API_KEY: "{{proxyKey}}" },
      argsTemplate: [
        "-c",
        'model_providers.lk.base_url="{{proxyUrl}}/v1"',
        "-m",
        "{{model}}",
      ],
      builtIn: true,
    }
    const resolver = createFakeCommandResolver({
      codex: "/usr/local/bin/codex",
    })
    const r = resolveHarnessLaunch({ resolver })({
      harness: codexLike,
      route: proxiedRoute,
    })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) return
    expect(r.value.args).toEqual([
      "-c",
      'model_providers.lk.base_url="http://127.0.0.1:4000/v1"',
      "-m",
      "mdl_x",
    ])
    expect(r.value.env).toEqual({ OPENAI_API_KEY: "k-secret" })
  })

  it("omits argsTemplate args in direct (bypass) mode", () => {
    const codexLike: HarnessDefinition = {
      id: HarnessIdSchema.parse("codex"),
      name: "Codex",
      command: "codex",
      apiFormat: "openai",
      envTemplate: { OPENAI_API_KEY: "{{proxyKey}}" },
      argsTemplate: ["-c", "x={{proxyUrl}}"],
      builtIn: true,
    }
    const resolver = createFakeCommandResolver({
      codex: "/usr/local/bin/codex",
    })
    const r = resolveHarnessLaunch({ resolver })({
      harness: codexLike,
      route: { kind: "direct" },
    })
    expect(isOk(r) && r.value.args).toEqual([])
  })

  it("renders no proxy env in direct (bypass) mode — only caller env reaches the harness", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const resolve = resolveHarnessLaunch({ resolver })
    const result = resolve({
      harness: claude,
      route: { kind: "direct" },
      env: { FOO: "bar" },
    })
    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.value.command).toBe("/usr/local/bin/claude")
    expect(result.value.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(result.value.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(result.value.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(result.value.env.FOO).toBe("bar")
  })

  it("surfaces the spawner's exited promise so callers can foreground the harness", async () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const spawner = createRecordingProcessSpawner(999, 42)

    const r = launchHarness({ resolver, spawner })(params)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(await r.value.exited).toBe(42)
  })

  it("returns an invalid-command error and never spawns when the command is relative", () => {
    const resolver = createFakeCommandResolver({})
    const spawner = createRecordingProcessSpawner(1)
    const relative: HarnessDefinition = { ...claude, command: "./claude" }

    const r = launchHarness({ resolver, spawner })({
      ...params,
      harness: relative,
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-command")
    expect(spawner.calls).toEqual([])
  })

  it("returns an invalid-command error and never spawns for a relative command even in direct (bypass) mode", () => {
    const resolver = createFakeCommandResolver({})
    const spawner = createRecordingProcessSpawner(1)
    const relative: HarnessDefinition = { ...claude, command: "./claude" }

    const r = launchHarness({ resolver, spawner })({
      harness: relative,
      route: { kind: "direct" },
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-command")
    expect(spawner.calls).toEqual([])
  })

  it("resolves the command and renders the env without spawning", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })

    const r = resolveHarnessLaunch({ resolver })(params)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.command).toBe("/usr/local/bin/claude")
    expect(r.value.args).toEqual([])
    expect(r.value.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
      ANTHROPIC_API_KEY: "k-secret",
      ANTHROPIC_MODEL: "mdl_x",
    })
  })

  it("returns an invalid-template error and never spawns when an env token is unknown", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const spawner = createRecordingProcessSpawner(1)
    const leaky: HarnessDefinition = {
      ...claude,
      envTemplate: { ANTHROPIC_API_KEY: "{{secret}}" },
    }

    const r = launchHarness({ resolver, spawner })({
      ...params,
      harness: leaky,
    })

    expect(r).toEqual({
      ok: false,
      error: { kind: "invalid-template", token: "secret" },
    })
    expect(spawner.calls).toEqual([])
  })

  it("merges params.env on top of the rendered template env (params.env wins)", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const r = resolveHarnessLaunch({ resolver })({
      ...params,
      env: { ANTHROPIC_MODEL: "override-model", EXTRA: "1" },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.env.ANTHROPIC_MODEL).toBe("override-model") // params.env wins
    expect(r.value.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000") // template kept
    expect(r.value.env.EXTRA).toBe("1") // extra key added
  })

  it("passes cwd through to the spawner on launch", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const spawner = createRecordingProcessSpawner(5)
    const r = launchHarness({ resolver, spawner })({
      ...params,
      cwd: "/work/dir",
    })
    expect(r.ok).toBe(true)
    expect(spawner.calls[0]?.cwd).toBe("/work/dir")
  })

  it("spawns with the merged env when params.env is given", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const spawner = createRecordingProcessSpawner(5)
    launchHarness({ resolver, spawner })({ ...params, env: { EXTRA: "yes" } })
    expect(spawner.calls[0]?.env.EXTRA).toBe("yes")
  })

  it("logs an error with { kind, detail } when the spawner reports spawn-failed", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const failingSpawner: ProcessSpawner = {
      spawn: (): Result<SpawnedProcess, HarnessError> =>
        err({ kind: "spawn-failed", detail: "ENOENT" }),
    }
    const logger = createFakeLogger()

    const r = launchHarness({ resolver, spawner: failingSpawner, logger })(
      params,
    )

    // Result is unchanged — logging is observation, not control flow.
    expect(r).toEqual({
      ok: false,
      error: { kind: "spawn-failed", detail: "ENOENT" },
    })
    expect(logger.records).toEqual([
      {
        level: "error",
        msg: "harness launch failed",
        fields: { kind: "spawn-failed", detail: "ENOENT" },
      },
    ])
  })

  it("logs an error with { kind, detail } when command resolution fails (read/resolve path)", () => {
    const failingResolver: CommandResolver = {
      resolve: (): Result<string, HarnessError> =>
        err({ kind: "invalid-command", detail: "command not found: claude" }),
    }
    const spawner = createRecordingProcessSpawner(1)
    const logger = createFakeLogger()

    const r = launchHarness({ resolver: failingResolver, spawner, logger })(
      params,
    )

    expect(r).toEqual({
      ok: false,
      error: { kind: "invalid-command", detail: "command not found: claude" },
    })
    expect(logger.records).toEqual([
      {
        level: "error",
        msg: "harness launch failed",
        fields: {
          kind: "invalid-command",
          detail: "command not found: claude",
        },
      },
    ])
  })

  it("never logs the rendered proxy env or per-run key on failure", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const failingSpawner: ProcessSpawner = {
      spawn: (): Result<SpawnedProcess, HarnessError> =>
        err({ kind: "spawn-failed", detail: "boom" }),
    }
    const logger = createFakeLogger()

    launchHarness({ resolver, spawner: failingSpawner, logger })(params)

    const serialized = JSON.stringify(logger.records)
    expect(serialized).not.toContain(proxiedRoute.proxyKey)
    expect(serialized).not.toContain(proxiedRoute.proxyUrl)
  })

  it("does not log on the success path", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const spawner = createRecordingProcessSpawner(7)
    const logger = createFakeLogger()

    const r = launchHarness({ resolver, spawner, logger })(params)

    expect(r.ok).toBe(true)
    expect(logger.records).toEqual([])
  })

  it("renders the wire model name into the env template when provided", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const r = resolveHarnessLaunch({ resolver })({
      harness: claude,
      route: {
        ...proxiedRoute,
        wireModel: "claude-spectrum-mdl_x",
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.env.ANTHROPIC_MODEL).toBe("claude-spectrum-mdl_x")
    }
  })

  it("falls back to the raw model id when wireModel is absent", () => {
    const resolver = createFakeCommandResolver({
      claude: "/usr/local/bin/claude",
    })
    const r = resolveHarnessLaunch({ resolver })({
      harness: claude,
      route: proxiedRoute,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.env.ANTHROPIC_MODEL).toBe("mdl_x")
    }
  })

  it("renders ANTHROPIC_SMALL_FAST_MODEL equal to the route model for a proxied claude launch", () => {
    const resolve = resolveHarnessLaunch({
      resolver: createFakeCommandResolver({ claude: "/usr/bin/claude" }),
    })
    const result = resolve({ harness: claudeBuiltin, route: proxiedRoute })
    expect(isOk(result)).toBe(true)
    if (!isOk(result)) return
    expect(result.value.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("mdl_x")
    expect(result.value.env.ANTHROPIC_MODEL).toBe("mdl_x")
  })
})

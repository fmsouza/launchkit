import { describe, expect, it } from "bun:test"
import {
  AliasNameSchema,
  type HarnessDefinition,
  HarnessIdSchema,
} from "@launchkit/types"
import { buildTrayMenu } from "./tray-menu"

const harness = (id: string, name: string): HarnessDefinition => ({
  id: HarnessIdSchema.parse(id),
  name,
  command: id,
  apiFormat: "anthropic",
  envTemplate: {
    ANTHROPIC_BASE_URL: "{{proxyUrl}}",
    ANTHROPIC_API_KEY: "{{proxyKey}}",
    ANTHROPIC_MODEL: "{{model}}",
  },
  defaultAlias: AliasNameSchema.parse("default"),
  builtIn: true,
})

describe("buildTrayMenu", () => {
  it("puts a green status dot at the top when the proxy is running", () => {
    const menu = buildTrayMenu({ harnesses: [], proxyRunning: true })
    expect(menu.items[0]).toEqual({
      kind: "status",
      label: "Proxy: on",
      dot: { state: "on", color: "green" },
      enabled: false,
    })
  })

  it("puts a grey status dot at the top when the proxy is not running", () => {
    const menu = buildTrayMenu({ harnesses: [], proxyRunning: false })
    expect(menu.items[0]).toEqual({
      kind: "status",
      label: "Proxy: off",
      dot: { state: "off", color: "grey" },
      enabled: false,
    })
  })

  it("adds a Launch submenu with one item per harness carrying its id", () => {
    const menu = buildTrayMenu({
      harnesses: [harness("claude", "Claude Code"), harness("codex", "Codex")],
      proxyRunning: true,
    })
    const submenu = menu.items.find((i) => i.kind === "submenu")
    expect(submenu).toEqual({
      kind: "submenu",
      label: "Launch",
      items: [
        { kind: "launch", label: "Claude Code", harnessId: "claude" },
        { kind: "launch", label: "Codex", harnessId: "codex" },
      ],
    })
  })

  it("shows a disabled placeholder in the Launch submenu when there are no harnesses", () => {
    const menu = buildTrayMenu({ harnesses: [], proxyRunning: true })
    const submenu = menu.items.find((i) => i.kind === "submenu")
    expect(submenu).toEqual({
      kind: "submenu",
      label: "Launch",
      items: [{ kind: "disabled", label: "No harnesses configured" }],
    })
  })

  it("ends with Open LaunchKit then Quit, separated from the rest", () => {
    const menu = buildTrayMenu({
      harnesses: [harness("claude", "Claude Code")],
      proxyRunning: true,
    })
    const tail = menu.items.slice(-3)
    expect(tail).toEqual([
      { kind: "separator" },
      { kind: "open", label: "Open LaunchKit" },
      { kind: "quit", label: "Quit" },
    ])
  })

  it("produces a fully serializable descriptor with no functions in it", () => {
    const menu = buildTrayMenu({
      harnesses: [harness("claude", "Claude Code")],
      proxyRunning: false,
    })
    // A round-trip through JSON proves the descriptor carries no functions/handles (purity contract).
    expect(JSON.parse(JSON.stringify(menu))).toEqual(menu)
  })
})

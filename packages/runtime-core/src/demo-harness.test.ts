import { describe, expect, it } from "bun:test"
import { type HarnessRegistry, claude } from "@spectrum/harnesses"
import type { HarnessId } from "@spectrum/types"
import { err, ok } from "@spectrum/utils"
import { demoHarness, withDemoHarness } from "./demo-harness"
import { DEMO_HARNESS_ID } from "./driver-registry"

const okRegistry = (): HarnessRegistry => ({
  list: async () => ok([claude]),
  add: async () => ok(undefined),
  remove: async () => ok(undefined),
})

describe("demoHarness", () => {
  it("uses the demo id so it routes to the native driver + native view", () => {
    expect(demoHarness.id).toBe(DEMO_HARNESS_ID as HarnessId)
  })

  it("uses a resolvable no-op command (true) that is never actually spawned", () => {
    expect(demoHarness.command).toBe("true")
  })

  it("is marked built-in so the UI does not offer to remove it", () => {
    expect(demoHarness.builtIn).toBe(true)
  })
})

describe("withDemoHarness", () => {
  it("appends the demo harness to the underlying registry's list", async () => {
    const reg = withDemoHarness(okRegistry())
    const listed = await reg.list()
    expect(listed.ok).toBe(true)
    const ids = listed.ok ? listed.value.map((h) => h.id) : []
    expect(ids).toContain(DEMO_HARNESS_ID as HarnessId)
    expect(ids).toContain("claude" as HarnessId)
  })

  it("preserves the underlying list error instead of masking it", async () => {
    const failing: HarnessRegistry = {
      list: async () => err({ kind: "read-failed", detail: "boom" }),
      add: async () => ok(undefined),
      remove: async () => ok(undefined),
    }
    const reg = withDemoHarness(failing)
    expect((await reg.list()).ok).toBe(false)
  })

  it("passes add/remove straight through to the underlying registry", async () => {
    const calls: string[] = []
    const inner: HarnessRegistry = {
      list: async () => ok([claude]),
      add: async () => {
        calls.push("add")
        return ok(undefined)
      },
      remove: async () => {
        calls.push("remove")
        return ok(undefined)
      },
    }
    const reg = withDemoHarness(inner)
    await reg.add({})
    await reg.remove("x")
    expect(calls).toEqual(["add", "remove"])
  })
})

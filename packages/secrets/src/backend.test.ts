import { describe, it, expect } from "bun:test"
import { isOk, isErr } from "@launchkit/utils"
import { createInMemoryKeychainBackend } from "./backend"

describe("createInMemoryKeychainBackend", () => {
  it("stores a secret and finds it back when add then find is called", async () => {
    const backend = createInMemoryKeychainBackend()
    const added = await backend.add("kc_1", "sk-secret")
    expect(isOk(added)).toBe(true)

    const found = await backend.find("kc_1")
    expect(found).toEqual({ ok: true, value: "sk-secret" })
  })

  it("returns a not-found error when find is called for an unknown account", async () => {
    const backend = createInMemoryKeychainBackend()
    const found = await backend.find("kc_missing")
    expect(found).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("overwrites the stored value when add is called twice for the same account", async () => {
    const backend = createInMemoryKeychainBackend()
    await backend.add("kc_1", "first")
    await backend.add("kc_1", "second")
    const found = await backend.find("kc_1")
    expect(found).toEqual({ ok: true, value: "second" })
  })

  it("removes a stored secret so a later find returns not-found", async () => {
    const backend = createInMemoryKeychainBackend()
    await backend.add("kc_1", "sk-secret")
    const removed = await backend.remove("kc_1")
    expect(isOk(removed)).toBe(true)

    const found = await backend.find("kc_1")
    expect(isErr(found)).toBe(true)
    if (isErr(found)) expect(found.error.kind).toBe("not-found")
  })

  it("returns a not-found error when remove is called for an unknown account", async () => {
    const backend = createInMemoryKeychainBackend()
    const removed = await backend.remove("kc_missing")
    expect(removed).toEqual({ ok: false, error: { kind: "not-found" } })
  })
})

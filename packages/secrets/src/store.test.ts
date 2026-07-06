import { describe, expect, it } from "bun:test"
import type { Logger } from "@spectrum/logger"
import { createSequentialIdGen } from "@spectrum/utils"
import {
  type KeychainBackend,
  type SecretError,
  createInMemoryKeychainBackend,
} from "./backend"
import { createSecretStore } from "./store"

type Captured = { msg: string; fields?: Record<string, unknown> | undefined }

const makeFakeLogger = (): { logger: Logger; warns: Captured[] } => {
  const warns: Captured[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      warns.push({ msg, fields })
    },
    error: () => {},
    fatal: () => {},
    child: () => logger,
  }
  return { logger, warns }
}

/** Backend whose every op fails with a fixed SecretError — never stores anything. */
const createFailingBackend = (error: SecretError): KeychainBackend => ({
  add: async () => ({ ok: false, error }),
  find: async () => ({ ok: false, error }),
  remove: async () => ({ ok: false, error }),
})

const makeStore = () => {
  const backend = createInMemoryKeychainBackend()
  const idGen = createSequentialIdGen()
  return { backend, store: createSecretStore({ backend, idGen }) }
}

describe("createSecretStore", () => {
  it("mints a kc-prefixed ref via the IdGen and returns it when set is called", async () => {
    const { store } = makeStore()
    const result = await store.set("sk-secret")
    expect(result).toEqual({ ok: true, value: { ref: "kc_1" } })
  })

  it("stores the value under the minted ref so get returns it", async () => {
    const { store } = makeStore()
    const set = await store.set("sk-secret")
    expect(set.ok).toBe(true)
    if (!set.ok) return

    const got = await store.get(set.value)
    expect(got).toEqual({ ok: true, value: "sk-secret" })
  })

  it("uses a fresh ref for each set so two secrets do not collide", async () => {
    const { store } = makeStore()
    const a = await store.set("secret-a")
    const b = await store.set("secret-b")
    expect(a).toEqual({ ok: true, value: { ref: "kc_1" } })
    expect(b).toEqual({ ok: true, value: { ref: "kc_2" } })
  })

  it("returns a not-found error when get is called for a ref that was never set", async () => {
    const { store } = makeStore()
    const got = await store.get({ ref: "kc_999" })
    expect(got).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("deletes the secret so a later get returns not-found", async () => {
    const { store } = makeStore()
    const set = await store.set("sk-secret")
    if (!set.ok) return

    const deleted = await store.delete(set.value)
    expect(deleted).toEqual({ ok: true, value: undefined })

    const got = await store.get(set.value)
    expect(got).toEqual({ ok: false, error: { kind: "not-found" } })
  })

  it("reports true from has when the ref exists and false otherwise", async () => {
    const { store } = makeStore()
    const set = await store.set("sk-secret")
    if (!set.ok) return

    expect(await store.has(set.value)).toBe(true)
    expect(await store.has({ ref: "kc_absent" })).toBe(false)
  })

  it("warns with { op: 'add', kind } and returns the error unchanged when set's backend fails", async () => {
    const { logger, warns } = makeFakeLogger()
    const backend = createFailingBackend({
      kind: "backend-failed",
      detail: "boom sk-super-secret-value",
    })
    const store = createSecretStore({
      backend,
      idGen: createSequentialIdGen(),
      logger,
    })

    const result = await store.set("sk-super-secret-value")

    expect(result).toEqual({
      ok: false,
      error: { kind: "backend-failed", detail: "boom sk-super-secret-value" },
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toEqual({
      msg: "keychain op failed",
      fields: { op: "add", kind: "backend-failed" },
    })
  })

  it("warns with { op: 'find', kind } and returns the error unchanged when get's backend fails", async () => {
    const { logger, warns } = makeFakeLogger()
    const backend = createFailingBackend({
      kind: "unavailable",
      detail: "no service",
    })
    const store = createSecretStore({
      backend,
      idGen: createSequentialIdGen(),
      logger,
    })

    const result = await store.get({ ref: "kc_1" })

    expect(result).toEqual({
      ok: false,
      error: { kind: "unavailable", detail: "no service" },
    })
    expect(warns).toEqual([
      {
        msg: "keychain op failed",
        fields: { op: "find", kind: "unavailable" },
      },
    ])
  })

  it("warns with { op: 'remove', kind } when delete's backend fails", async () => {
    const { logger, warns } = makeFakeLogger()
    const backend = createFailingBackend({
      kind: "backend-failed",
      detail: "rm failed",
    })
    const store = createSecretStore({
      backend,
      idGen: createSequentialIdGen(),
      logger,
    })

    await store.delete({ ref: "kc_1" })

    expect(warns).toEqual([
      {
        msg: "keychain op failed",
        fields: { op: "remove", kind: "backend-failed" },
      },
    ])
  })

  it("never logs the secret value, ref, or error detail in any warn field", async () => {
    const { logger, warns } = makeFakeLogger()
    const backend = createFailingBackend({
      kind: "backend-failed",
      detail: "leak sk-top-secret",
    })
    const store = createSecretStore({
      backend,
      idGen: createSequentialIdGen(),
      logger,
    })

    await store.set("sk-top-secret")
    await store.get({ ref: "kc_secret_ref" })
    await store.delete({ ref: "kc_secret_ref" })

    const serialized = JSON.stringify(warns)
    expect(serialized).not.toContain("sk-top-secret")
    expect(serialized).not.toContain("kc_secret_ref")
    expect(serialized).not.toContain("leak")
  })

  it("does not warn on a not-found get (not a backend failure)", async () => {
    const { logger, warns } = makeFakeLogger()
    const backend = createInMemoryKeychainBackend()
    const store = createSecretStore({
      backend,
      idGen: createSequentialIdGen(),
      logger,
    })

    await store.get({ ref: "kc_999" })

    expect(warns).toEqual([])
  })

  it("does not throw when no logger is injected and a backend op fails", async () => {
    const backend = createFailingBackend({
      kind: "backend-failed",
      detail: "x",
    })
    const store = createSecretStore({
      backend,
      idGen: createSequentialIdGen(),
    })

    const result = await store.set("sk-secret")
    expect(result).toEqual({
      ok: false,
      error: { kind: "backend-failed", detail: "x" },
    })
  })
})

import { type Result, ok, err } from "@launchkit/utils"

/** Typed failure modes for any keychain operation. */
export type SecretError =
  | { readonly kind: "not-found" }
  | { readonly kind: "backend-failed"; readonly detail: string }

/**
 * The keychain effect. The only thing `SecretStore` knows about the OS keychain.
 * `account` is the keychain-id the secret is stored under (a `SecretRef.ref`).
 */
export interface KeychainBackend {
  add(account: string, secret: string): Promise<Result<void, SecretError>>
  find(account: string): Promise<Result<string, SecretError>>
  remove(account: string): Promise<Result<void, SecretError>>
}

/** Map-based fake for unit tests — no real keychain, fast, deterministic. */
export const createInMemoryKeychainBackend = (): KeychainBackend => {
  const store = new Map<string, string>()
  return {
    add: async (account, secret) => {
      store.set(account, secret)
      return ok(undefined)
    },
    find: async (account) => {
      const secret = store.get(account)
      return secret === undefined ? err({ kind: "not-found" }) : ok(secret)
    },
    remove: async (account) => {
      if (!store.has(account)) return err({ kind: "not-found" })
      store.delete(account)
      return ok(undefined)
    },
  }
}

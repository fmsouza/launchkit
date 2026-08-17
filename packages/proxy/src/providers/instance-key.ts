import type { SecretRef } from "@spectrum/types"

/**
 * The identity of one configured provider's supervised child process.
 *
 * ONE definition, used by the provider factory's instance cache AND by the composition root's
 * retention sweep. Two independently-maintained copies of this formula would drift, and a
 * drifted key means the sweep retains keys nothing will ever ask for while the processes it
 * meant to retire stay alive holding stale secrets.
 */
export type ProviderInstanceKeyInput = {
  readonly sdkProvider: string
  readonly config: Readonly<Record<string, string>>
  /** Secret REFERENCES, never values — a keychain handle, not the secret behind it. */
  readonly secretRefs: Readonly<Record<string, SecretRef>>
}

/** Key order is normalised so two structurally equal records always produce the same key. */
const canonical = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )

export const providerInstanceKey = (input: ProviderInstanceKeyInput): string =>
  JSON.stringify({
    s: input.sdkProvider,
    c: canonical(input.config),
    r: canonical(input.secretRefs),
  })

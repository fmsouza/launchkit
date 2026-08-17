import { HOST_TOKEN_HEADER } from "./host-token"

export type HealthProbe = (
  url: string,
) => Promise<{ ok: boolean; token: string | undefined }>

export const createFetchHealthProbe = (): HealthProbe => {
  return async (url: string) => {
    try {
      const response = await fetch(url)
      return {
        ok: response.ok,
        token: response.headers.get(HOST_TOKEN_HEADER) ?? undefined,
      }
    } catch {
      return { ok: false, token: undefined }
    }
  }
}

export type Sleep = (ms: number) => Promise<void>

const INITIAL_BACKOFF_MS = 50
const MAX_BACKOFF_MS = 500

/**
 * A launched plugin proves it is the process Spectrum spawned by echoing the host token
 * it was given in its env. This closes the port-race impersonation window on the path
 * that matters: flows carry OAuth tokens, and a process that won the race would otherwise
 * receive them. A plugin with no launch block (user-run) has no token and is not checked.
 */
export const waitForReady = async (
  deps: { probe: HealthProbe; sleep: Sleep },
  input: {
    url: string
    expectedToken: string | undefined
    timeoutMs: number
    now: () => number
  },
): Promise<boolean> => {
  const { probe, sleep } = deps
  const { url, expectedToken, timeoutMs, now } = input
  const deadline = now() + timeoutMs
  let backoff = INITIAL_BACKOFF_MS

  for (;;) {
    const result = await probe(url)
    if (
      result.ok &&
      (expectedToken === undefined || result.token === expectedToken)
    ) {
      return true
    }

    if (now() >= deadline) {
      return false
    }

    await sleep(backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}

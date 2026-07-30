import { describe, expect, it } from "bun:test"
import { createBunProcessRunner } from "./bun-process-runner"
import { createDpapiCipher } from "./cipher-dpapi"

const DPAPI_PROBE_TIMEOUT_MS = 5000

async function probeDpapiAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return false
  try {
    const cipher = createDpapiCipher({ runner: createBunProcessRunner() })
    const result = (await Promise.race([
      cipher.encrypt("probe"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("dpapi probe timeout")),
          DPAPI_PROBE_TIMEOUT_MS,
        ),
      ),
    ])) as Awaited<ReturnType<typeof cipher.encrypt>>
    return result.ok
  } catch {
    return false
  }
}

const dpapiAvailable = await probeDpapiAvailable()

// Real PowerShell + DPAPI only exist on Windows and only in environments where the
// CurrentUser scope responds promptly (CI runners can hang). Probe first and skip when
// DPAPI is unavailable or unresponsive.
const describeDpapi = dpapiAvailable ? describe : describe.skip

describeDpapi("createDpapiCipher (real DPAPI)", () => {
  it("round-trips a secret through real DPAPI Protect/Unprotect", async () => {
    const cipher = createDpapiCipher({ runner: createBunProcessRunner() })
    const enc = await cipher.encrypt("sk-windows-secret")
    expect(enc.ok).toBe(true)
    if (!enc.ok) return
    expect(enc.value).not.toContain("sk-windows-secret")
    expect(await cipher.decrypt(enc.value)).toEqual({
      ok: true,
      value: "sk-windows-secret",
    })
  }, 30000)
})

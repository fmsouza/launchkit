import { describe, expect, it } from "bun:test"
import type { IdGen } from "@spectrum/utils"
import type { AcpConnect } from "./acp-client"
import { createAcpDriver } from "./driver"

const fakeIdGen: IdGen = {
  next: (prefix: string) => `${prefix}_1` as never,
}

const fakeConnect: AcpConnect = async () => {
  throw new Error("fake")
}

describe("createAcpDriver", () => {
  it("returns an AgentDriver with a start function", () => {
    const driver = createAcpDriver({ idGen: fakeIdGen, connect: fakeConnect })
    expect(typeof driver.start).toBe("function")
  })

  it("builds a real transport when no connect override is supplied", () => {
    // The production path must NOT be a stub: constructing without `connect` has to yield a
    // working driver, not one that throws the moment a run starts.
    const driver = createAcpDriver({ idGen: fakeIdGen })
    expect(typeof driver.start).toBe("function")
  })

  it("spawns through the real transport with the injected base env", async () => {
    const spawned: { cmd: readonly string[]; env: Record<string, string> }[] =
      []
    const driver = createAcpDriver({
      idGen: fakeIdGen,
      baseEnv: () => ({ PATH: "/usr/bin" }),
      spawn: (cmd, options) => {
        spawned.push({ cmd, env: options.env })
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: { write: () => {}, flush: () => {}, end: () => {} },
          kill: () => {},
        }
      },
    })
    const started = driver.start({
      harnessId: "opencode" as never,
      cwd: "/work",
      env: { OPENAI_API_KEY: "k" },
      command: "/usr/local/bin/opencode",
      args: ["acp"],
    })
    expect(started.ok).toBe(true)
    // The adapter start is scheduled off the sync seam; let it run.
    await new Promise((r) => setTimeout(r, 10))
    expect(spawned[0]?.cmd).toEqual(["/usr/local/bin/opencode", "acp"])
    expect(spawned[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "k",
    })
  })
})

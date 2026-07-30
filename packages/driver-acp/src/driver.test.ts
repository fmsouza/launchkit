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
})

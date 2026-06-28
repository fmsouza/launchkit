import { describe, expect, it } from "bun:test"
import { GetUpdateSocketUrlResultSchema, IpcMethodSchemas } from "./methods"

const sampleState = {
  phase: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  latestHash: "1wg7wj2g0bm4w",
  available: true,
  progress: 0,
  error: null,
  channel: "stable",
  showBanner: true,
}

describe("update IPC schemas", () => {
  it("validates a full UpdateState result for getUpdateState", () => {
    const parsed = IpcMethodSchemas.getUpdateState.result.parse(sampleState)
    expect(parsed.phase).toBe("available")
    expect(parsed.showBanner).toBe(true)
  })

  it("validates a null latestHash when up-to-date", () => {
    const parsed = IpcMethodSchemas.getUpdateState.result.parse({
      ...sampleState,
      available: false,
      phase: "up-to-date",
      latestVersion: null,
      latestHash: null,
    })
    expect(parsed.latestHash).toBeNull()
  })

  it("rejects an unknown phase", () => {
    expect(
      IpcMethodSchemas.getUpdateState.result.safeParse({
        ...sampleState,
        phase: "bogus",
      }).success,
    ).toBe(false)
  })

  it("validates setUpdateChannel params", () => {
    expect(
      IpcMethodSchemas.setUpdateChannel.params.parse({ channel: "canary" }),
    ).toEqual({ channel: "canary" })
    expect(
      IpcMethodSchemas.setUpdateChannel.params.safeParse({ channel: "beta" })
        .success,
    ).toBe(false)
  })

  it("validates dismissUpdate params by build hash", () => {
    expect(
      IpcMethodSchemas.dismissUpdate.params.parse({ hash: "1wg7wj2g0bm4w" }),
    ).toEqual({ hash: "1wg7wj2g0bm4w" })
  })

  it("rejects a dismissUpdate with an empty hash", () => {
    expect(
      IpcMethodSchemas.dismissUpdate.params.safeParse({ hash: "" }).success,
    ).toBe(false)
  })

  it("encodes void results as null for download/apply", () => {
    expect(IpcMethodSchemas.startUpdateDownload.result.parse(null)).toBeNull()
    expect(IpcMethodSchemas.applyUpdate.result.parse(null)).toBeNull()
  })

  it("getUpdateSocketUrl result round-trips", () => {
    const parsed = GetUpdateSocketUrlResultSchema.parse({
      url: "ws://localhost:12345/",
    })
    expect(parsed).toEqual({ url: "ws://localhost:12345/" })
  })
})

import { expect, it } from "bun:test"
import type { CanonicalEvent } from "@spectrum/agent-events"
import { createSequentialIdGen } from "@spectrum/utils"
import type { AdapterCtx, AdapterHandle, DriverAdapter } from "./adapter"
import { createDriver } from "./runtime"

const sync = (fn: () => void): void => fn()

const noopAdapter: DriverAdapter = {
  start: (_input, _ctx: AdapterCtx): Promise<AdapterHandle> =>
    Promise.resolve({
      send: () => {},
      interrupt: () => {},
      close: () => {},
    }),
}

it("echoes the user text-delta with the clientSendId from send", () => {
  const events: CanonicalEvent[] = []
  const driver = createDriver({
    adapter: noopAdapter,
    idGen: createSequentialIdGen(),
    scheduler: sync,
  })
  const started = driver.start({
    harnessId: "demo" as never,
    cwd: "/",
    env: {},
  })
  if (!started.ok) throw new Error("start failed")
  started.value.onEvent((e) => events.push(e))
  started.value.send({ text: "hello", clientSendId: "c1" })
  const echo = events.find((e) => e.type === "text-delta" && e.role === "user")
  expect(echo).toBeDefined()
  if (echo?.type === "text-delta") expect(echo.clientSendId).toBe("c1")
})

import { describe, expect, it } from "bun:test"
import type { HarnessView } from "@spectrum/ipc"
import type { HarnessId } from "@spectrum/types"
import { createFakeIpcClient } from "../test/fake-client"
import { createHarnessesStore } from "./harnessesStore"

const def: HarnessView = {
  id: "claude" as HarnessId,
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: {},
  builtIn: true,
  native: false,
}

describe("createHarnessesStore", () => {
  it("loads harness definitions via fetch", async () => {
    const store = createHarnessesStore({
      client: createFakeIpcClient({
        getHarnesses: async () => ({ ok: true, value: [def] }),
      }),
    })
    await store.getState().fetch()
    expect(store.getState().data).toEqual([def])
  })
})

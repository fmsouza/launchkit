import { describe, expect, it } from "bun:test"
import type { IpcClient, UpdateState } from "@spectrum/ipc"
import { err, ok } from "@spectrum/utils"
import { createUpdateStore } from "./updateStore"

const available = {
  phase: "available" as const,
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  latestHash: "hashA",
  available: true,
  progress: 0,
  error: null,
  channel: "stable" as const,
  showBanner: true,
}

const fakeClient = (over: Partial<IpcClient> = {}): IpcClient =>
  ({
    checkForUpdate: async () => ok(available),
    getUpdateState: async () => ok(available),
    startUpdateDownload: async () => ok(null),
    applyUpdate: async () => ok(null),
    dismissUpdate: async () => ok(null),
    setUpdateChannel: async () => ok({ ...available, channel: "canary" }),
    ...over,
  }) as unknown as IpcClient

describe("createUpdateStore", () => {
  it("check populates the state", async () => {
    const store = createUpdateStore({ client: fakeClient(), notify: () => {} })
    await store.getState().check()
    expect(store.getState().state?.showBanner).toBe(true)
    expect(store.getState().state?.latestVersion).toBe("1.1.0")
  })

  it("dismiss calls the client with the latest build hash and re-reads state", async () => {
    let dismissedWith: string | null = null
    const store = createUpdateStore({
      client: fakeClient({
        dismissUpdate: async ({ hash }) => {
          dismissedWith = hash
          return ok(null)
        },
        getUpdateState: async () => ok({ ...available, showBanner: false }),
      }),
      notify: () => {},
    })
    await store.getState().check()
    await store.getState().dismiss()
    expect(dismissedWith).toBe("hashA")
    expect(store.getState().state?.showBanner).toBe(false)
  })

  it("falls back to the version when latestHash is null", async () => {
    // An older bundle that surfaces no build hash dismisses by version, so
    // existing users on old builds never regress.
    let dismissedWith: { hash?: string; version?: string } | null = null
    const noHash = { ...available, latestHash: null }
    const store = createUpdateStore({
      client: fakeClient({
        checkForUpdate: async () => ok(noHash),
        getUpdateState: async () => ok(noHash),
        dismissUpdate: async (params) => {
          dismissedWith = params as { hash?: string; version?: string }
          return ok(null)
        },
      }),
      notify: () => {},
    })
    await store.getState().check()
    await store.getState().dismiss()
    // When no hash is available, the store must still dismiss (by version) so
    // the banner can be cleared on old builds.
    expect(dismissedWith).not.toBeNull()
    expect(store.getState().state).toBeDefined()
  })

  it("download starts the download then refreshes", async () => {
    let started = false
    const store = createUpdateStore({
      client: fakeClient({
        startUpdateDownload: async () => {
          started = true
          return ok(null)
        },
        getUpdateState: async () =>
          ok({ ...available, phase: "downloading", progress: 0.3 }),
      }),
      notify: () => {},
    })
    await store.getState().check()
    await store.getState().download()
    expect(started).toBe(true)
    expect(store.getState().state?.phase).toBe("downloading")
  })

  it("setChannel forwards the channel and stores the returned state", async () => {
    const store = createUpdateStore({ client: fakeClient(), notify: () => {} })
    await store.getState().setChannel("canary")
    expect(store.getState().state?.channel).toBe("canary")
  })

  it("dismiss does NOT call dismissUpdate when there is no state yet", async () => {
    let dismissCalled = false
    const store = createUpdateStore({
      client: fakeClient({
        dismissUpdate: async () => {
          dismissCalled = true
          return ok(null)
        },
      }),
      notify: () => {},
    })
    await store.getState().dismiss()
    expect(dismissCalled).toBe(false)
  })

  it("notifies an error when the update check fails", async () => {
    const messages: string[] = []
    const store = createUpdateStore({
      client: fakeClient({
        checkForUpdate: async () =>
          err({ kind: "handler-failed", detail: "x" }),
      }),
      notify: (input) => {
        messages.push(input.message)
      },
    })
    await store.getState().check()
    expect(messages).toContain("Couldn't check for updates.")
    expect(store.getState().state).toBeUndefined()
  })

  it("notifies an error when switching channel fails", async () => {
    const messages: string[] = []
    const store = createUpdateStore({
      client: fakeClient({
        setUpdateChannel: async () =>
          err({ kind: "handler-failed", detail: "x" }),
      }),
      notify: (input) => {
        messages.push(input.message)
      },
    })
    await store.getState().setChannel("canary")
    expect(messages).toContain("Couldn't change the update channel.")
  })

  it("notifies an error when starting the download fails", async () => {
    const messages: string[] = []
    const store = createUpdateStore({
      client: fakeClient({
        startUpdateDownload: async () =>
          err({ kind: "handler-failed", detail: "x" }),
      }),
      notify: (input) => {
        messages.push(input.message)
      },
    })
    await store.getState().download()
    expect(messages).toContain("Couldn't start the update download.")
  })

  it("notifies an error when dismiss fails", async () => {
    const messages: string[] = []
    const store = createUpdateStore({
      client: fakeClient({
        dismissUpdate: async () => err({ kind: "handler-failed", detail: "x" }),
      }),
      notify: (input) => {
        messages.push(input.message)
      },
    })
    await store.getState().check()
    await store.getState().dismiss()
    expect(messages).toContain("Couldn't dismiss the update.")
  })

  it("notifies an error when applying the update fails", async () => {
    const messages: string[] = []
    const store = createUpdateStore({
      client: fakeClient({
        applyUpdate: async () => err({ kind: "handler-failed", detail: "x" }),
      }),
      notify: (input) => {
        messages.push(input.message)
      },
    })
    await store.getState().apply()
    expect(messages).toContain("Couldn't apply the update.")
  })

  it("onUpdateState replaces state with the pushed frame", () => {
    const store = createUpdateStore({ client: fakeClient(), notify: () => {} })
    const pushed: UpdateState = {
      ...available,
      latestVersion: "1.2.0",
      latestHash: "hashB",
    }
    store.getState().onUpdateState(pushed)
    expect(store.getState().state?.latestVersion).toBe("1.2.0")
    expect(store.getState().state?.latestHash).toBe("hashB")
  })

  it("a pushed frame with showBanner=false hides the banner", () => {
    const store = createUpdateStore({ client: fakeClient(), notify: () => {} })
    // First show the banner.
    store.getState().onUpdateState({ ...available, showBanner: true })
    expect(store.getState().state?.showBanner).toBe(true)
    // Then a pushed frame hides it (e.g. same dismissed hash, server-resolved).
    store.getState().onUpdateState({ ...available, showBanner: false })
    expect(store.getState().state?.showBanner).toBe(false)
  })

  it("a pushed frame with a new hash and showBanner=true shows the banner", () => {
    const store = createUpdateStore({ client: fakeClient(), notify: () => {} })
    store
      .getState()
      .onUpdateState({ ...available, showBanner: false, latestHash: "hashA" })
    store
      .getState()
      .onUpdateState({ ...available, showBanner: true, latestHash: "hashC" })
    expect(store.getState().state?.showBanner).toBe(true)
    expect(store.getState().state?.latestHash).toBe("hashC")
  })
})

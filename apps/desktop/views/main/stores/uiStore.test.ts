import { describe, expect, it } from "bun:test"
import type { SessionId } from "@spectrum/types"
import { createUiStore, encodeView, parseView } from "./uiStore"

describe("uiStore view helpers", () => {
  it("parses and encodes the settings view", () => {
    expect(parseView("settings/providers")).toEqual({
      kind: "settings",
      section: "providers",
    })
    expect(encodeView({ kind: "settings", section: "providers" })).toBe(
      "#settings/providers",
    )
  })

  it("collapses unknown hashes to the sessions view", () => {
    expect(parseView("dashboard")).toEqual({ kind: "sessions" })
  })

  it("maps an empty hash to the sessions view", () => {
    expect(parseView("")).toEqual({ kind: "sessions" })
  })
})

describe("createUiStore", () => {
  it("seeds the view from the initial hash", () => {
    const store = createUiStore("settings/models")
    expect(store.getState().view).toEqual({
      kind: "settings",
      section: "models",
    })
  })

  it("navigate replaces the view", () => {
    const store = createUiStore("sessions")
    store.getState().navigate({ kind: "settings", section: "general" })
    expect(store.getState().view).toEqual({
      kind: "settings",
      section: "general",
    })
  })

  it("openSession adds an id once; closeSession removes it", () => {
    const store = createUiStore("sessions")
    store.getState().openSession("s_1" as SessionId)
    store.getState().openSession("s_1" as SessionId)
    expect(store.getState().openSessionIds).toEqual(["s_1"] as SessionId[])
    store.getState().closeSession("s_1" as SessionId)
    expect(store.getState().openSessionIds).toEqual([])
  })

  it("toggles the modal", () => {
    const store = createUiStore("sessions")
    store.getState().setModalOpen(true)
    expect(store.getState().modalOpen).toBe(true)
  })
})

import { describe, expect, it } from "bun:test"
import { MAX_UPLOAD_BYTES } from "@spectrum/agent-events"
import type { HarnessId, ModelId, ProviderId } from "@spectrum/types"
import {
  AddModelParamsSchema,
  AddModelResultSchema,
  AddProviderParamsSchema,
  DeleteModelParamsSchema,
  DeleteModelResultSchema,
  GetModelsParamsSchema,
  GetModelsResultSchema,
  GetSessionsParamsSchema,
  GetSettingsParamsSchema,
  GetSettingsResultSchema,
  IpcMethodSchemas,
  LaunchHarnessParamsSchema,
  LaunchHarnessResultSchema,
  PickFolderParamsSchema,
  PickFolderResultSchema,
  SaveDroppedUploadsParamsSchema,
  SetProviderSecretParamsSchema,
  UpdateHarnessPrefsParamsSchema,
  UpdateModelParamsSchema,
  UpdateModelResultSchema,
} from "./methods"

const sampleModelRoute = {
  id: "mdl_x" as ModelId,
  providerId: "openai" as ProviderId,
  providerModel: "gpt-4o",
  aliases: [] as string[],
  attachments: {} as { image?: boolean; pdf?: boolean },
}

describe("AddProviderParamsSchema", () => {
  it("parses an input with non-secret config and secret field names", () => {
    const input = {
      name: "OpenAI",
      sdkProvider: "openai" as const,
      config: { baseUrl: "https://api.openai.com/v1" },
      secretFieldNames: ["apiKey"],
      models: ["gpt-4o"],
    }
    expect(AddProviderParamsSchema.parse(input)).toEqual(input)
  })
  it("accepts an optional inline secrets record for an atomic create", () => {
    const input = {
      name: "OpenAI",
      sdkProvider: "openai" as const,
      config: { baseUrl: "x" },
      secretFieldNames: ["apiKey"],
      models: ["gpt-4o"],
      secrets: { apiKey: "sk-live" },
    }
    const r = AddProviderParamsSchema.safeParse(input)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.secrets).toEqual({ apiKey: "sk-live" })
  })
})

describe("SetProviderSecretParamsSchema", () => {
  it("parses the only secret-bearing method's params", () => {
    const p = {
      providerId: "p_openai" as ProviderId,
      field: "apiKey",
      value: "sk-secret",
    }
    expect(SetProviderSecretParamsSchema.parse(p)).toEqual(p)
  })
  it("rejects an empty secret value", () => {
    expect(
      SetProviderSecretParamsSchema.safeParse({
        providerId: "p" as ProviderId,
        field: "apiKey",
        value: "",
      }).success,
    ).toBe(false)
  })
})

describe("GetModelsResultSchema", () => {
  it("parses an array of model routes", () => {
    expect(GetModelsResultSchema.parse([sampleModelRoute])).toEqual([
      sampleModelRoute,
    ])
  })
  it("rejects a non-array result", () => {
    expect(GetModelsResultSchema.safeParse({}).success).toBe(false)
  })
})

describe("GetModelsParamsSchema", () => {
  it("parses undefined params", () => {
    expect(GetModelsParamsSchema.parse(undefined)).toBeUndefined()
  })
})

describe("AddModelParamsSchema", () => {
  it("AddModelParamsSchema accepts providerId + providerModel (server mints id)", () => {
    expect(
      AddModelParamsSchema.safeParse({
        providerId: "openai",
        providerModel: "gpt-4o",
      }).success,
    ).toBe(true)
  })
  it("rejects an input that supplies an id (server mints it)", () => {
    expect(
      AddModelParamsSchema.safeParse({
        id: "mdl_x",
        providerId: "openai",
        providerModel: "gpt-4o",
      }).success,
    ).toBe(false)
  })
  it("rejects an empty providerModel", () => {
    expect(
      AddModelParamsSchema.safeParse({
        providerId: "openai",
        providerModel: "",
      }).success,
    ).toBe(false)
  })
  it("AddModelParams accepts optional aliases", () => {
    const r = AddModelParamsSchema.safeParse({
      providerId: "p1",
      providerModel: "claude-haiku-4-5",
      aliases: ["haiku"],
    })
    expect(r.success).toBe(true)
  })
})

describe("AddModelResultSchema", () => {
  it("parses a full model route carrying the minted id", () => {
    expect(AddModelResultSchema.parse(sampleModelRoute)).toEqual(
      sampleModelRoute,
    )
  })
})

describe("UpdateModelParamsSchema", () => {
  it("keys by id and carries the new provider + model (sans id)", () => {
    const params = {
      id: "mdl_x" as ModelId,
      input: {
        providerId: "openai" as ProviderId,
        providerModel: "gpt-4o",
        aliases: [] as string[],
        attachments: {} as { image?: boolean; pdf?: boolean },
      },
    }
    expect(UpdateModelParamsSchema.parse(params)).toEqual(params)
  })
  it("rejects an input that smuggles an id", () => {
    expect(
      UpdateModelParamsSchema.safeParse({
        id: "mdl_x",
        input: {
          id: "mdl_y",
          providerId: "openai",
          providerModel: "gpt-4o",
        },
      }).success,
    ).toBe(false)
  })
  it("rejects params missing the id", () => {
    expect(
      UpdateModelParamsSchema.safeParse({
        input: { providerId: "openai", providerModel: "gpt-4o" },
      }).success,
    ).toBe(false)
  })
})

describe("UpdateModelResultSchema", () => {
  it("parses the updated model route", () => {
    expect(UpdateModelResultSchema.parse(sampleModelRoute)).toEqual(
      sampleModelRoute,
    )
  })
})

describe("DeleteModelParamsSchema", () => {
  it("DeleteModelParamsSchema requires a model id", () => {
    expect(DeleteModelParamsSchema.safeParse({ id: "mdl_x" }).success).toBe(
      true,
    )
    expect(DeleteModelParamsSchema.safeParse({}).success).toBe(false)
  })
  it("rejects extra keys", () => {
    expect(
      DeleteModelParamsSchema.safeParse({ id: "mdl_x", extra: 1 }).success,
    ).toBe(false)
  })
})

describe("DeleteModelResultSchema", () => {
  it("parses null (void) as the result", () => {
    expect(DeleteModelResultSchema.parse(null)).toBeNull()
  })
})

describe("LaunchHarnessParamsSchema", () => {
  it("LaunchHarnessParamsSchema accepts an optional modelId", () => {
    expect(LaunchHarnessParamsSchema.safeParse({ id: "claude" }).success).toBe(
      true,
    )
    expect(
      LaunchHarnessParamsSchema.safeParse({ id: "claude", modelId: "mdl_x" })
        .success,
    ).toBe(true)
  })
  it("parses with an optional modelId omitted", () => {
    expect(
      LaunchHarnessParamsSchema.parse({ id: "claude" as HarnessId }),
    ).toEqual({ id: "claude" as HarnessId })
  })
  it("parses with a modelId provided", () => {
    expect(
      LaunchHarnessParamsSchema.parse({
        id: "claude" as HarnessId,
        modelId: "mdl_x" as ModelId,
      }),
    ).toEqual({ id: "claude" as HarnessId, modelId: "mdl_x" as ModelId })
  })
  it("parses launch params with name, cwd, and env", () => {
    expect(
      LaunchHarnessParamsSchema.parse({
        id: "claude" as HarnessId,
        modelId: "mdl_x" as ModelId,
        name: "My run",
        cwd: "/Users/fred/projects/app",
        env: { ANTHROPIC_MODEL: "sonnet" },
      }),
    ).toEqual({
      id: "claude" as HarnessId,
      modelId: "mdl_x" as ModelId,
      name: "My run",
      cwd: "/Users/fred/projects/app",
      env: { ANTHROPIC_MODEL: "sonnet" },
    })
  })
  it("rejects an env whose values are not strings", () => {
    expect(
      LaunchHarnessParamsSchema.safeParse({
        id: "claude" as HarnessId,
        env: { PORT: 8080 },
      }).success,
    ).toBe(false)
  })
})

describe("LaunchHarnessResultSchema", () => {
  it("parses a result carrying only the created sessionId", () => {
    const parsed = LaunchHarnessResultSchema.parse({ sessionId: "s_1" })
    expect(parsed.sessionId).toBe("s_1" as typeof parsed.sessionId)
  })
  it("rejects a result missing the sessionId", () => {
    expect(LaunchHarnessResultSchema.safeParse({}).success).toBe(false)
  })
})

describe("GetSessionsParamsSchema", () => {
  it("parses an absent filter as undefined", () => {
    expect(GetSessionsParamsSchema.parse(undefined)).toBeUndefined()
  })
  it("parses a filter narrowing by harnessId", () => {
    expect(
      GetSessionsParamsSchema.parse({ harnessId: "claude" as HarnessId }),
    ).toEqual({ harnessId: "claude" as HarnessId })
  })
  it("parses a filter narrowing by running, limit, and offset", () => {
    expect(
      GetSessionsParamsSchema.parse({ running: true, limit: 20, offset: 0 }),
    ).toEqual({ running: true, limit: 20, offset: 0 })
  })
  it("rejects a non-positive limit", () => {
    expect(GetSessionsParamsSchema.safeParse({ limit: 0 }).success).toBe(false)
  })
  it("rejects a negative offset", () => {
    expect(GetSessionsParamsSchema.safeParse({ offset: -1 }).success).toBe(
      false,
    )
  })
})

describe("PickFolderParamsSchema", () => {
  it("parses omitted params (undefined)", () => {
    expect(PickFolderParamsSchema.parse(undefined)).toBeUndefined()
  })
  it("parses a starting folder hint", () => {
    expect(
      PickFolderParamsSchema.parse({ startingFolder: "/Users/fred" }),
    ).toEqual({ startingFolder: "/Users/fred" })
  })
  it("rejects extra keys", () => {
    expect(
      PickFolderParamsSchema.safeParse({ startingFolder: "/x", extra: 1 })
        .success,
    ).toBe(false)
  })
})

describe("PickFolderResultSchema", () => {
  it("parses a chosen path", () => {
    expect(PickFolderResultSchema.parse({ path: "/Users/fred/app" })).toEqual({
      path: "/Users/fred/app",
    })
  })
  it("parses an empty object (dialog cancelled)", () => {
    expect(PickFolderResultSchema.parse({})).toEqual({})
  })
})

describe("GetSettingsParamsSchema", () => {
  it("parses undefined params", () => {
    expect(GetSettingsParamsSchema.parse(undefined)).toBeUndefined()
  })
})

describe("GetSettingsResultSchema", () => {
  it("parses a result carrying all three persisted fields (no lastSelectedModelId)", () => {
    expect(
      GetSettingsResultSchema.parse({
        lastSelectedFolder: "/home/me/proj",
        lastSelectedHarnessId: "claude",
        collapsedProjects: [],
      }),
    ).toEqual({
      lastSelectedFolder: "/home/me/proj",
      lastSelectedHarnessId: "claude",
      collapsedProjects: [],
    })
  })
  it("validates a getSettings result with all three persisted fields", () => {
    const result = GetSettingsResultSchema.safeParse({
      lastSelectedFolder: "/p",
      lastSelectedHarnessId: "claude",
      collapsedProjects: ["prj_1"],
    })
    expect(result.success).toBe(true)
  })
  it("rejects a getSettings result missing lastSelectedHarnessId", () => {
    const result = GetSettingsResultSchema.safeParse({
      lastSelectedFolder: "/p",
      collapsedProjects: [],
    })
    expect(result.success).toBe(false)
  })
  it("rejects a result missing lastSelectedFolder", () => {
    expect(GetSettingsResultSchema.safeParse({}).success).toBe(false)
  })
  it("rejects extra keys (no lastSelectedModelId on the wire)", () => {
    expect(
      GetSettingsResultSchema.safeParse({
        lastSelectedFolder: "/x",
        lastSelectedHarnessId: "claude",
        collapsedProjects: [],
        extra: 1,
      }).success,
    ).toBe(false)
  })
  it("no longer carries the removed lastSelectedModelId (strict)", () => {
    expect(
      GetSettingsResultSchema.safeParse({
        lastSelectedFolder: "/x",
        lastSelectedHarnessId: "claude",
        lastSelectedModelId: "mdl_x",
        collapsedProjects: [],
      }).success,
    ).toBe(false)
  })
})

describe("IpcMethodSchemas", () => {
  it("exposes a params and result schema for every contract method", () => {
    const expected = [
      "getProviders",
      "getProviderCatalog",
      "addProvider",
      "updateProvider",
      "deleteProvider",
      "testProvider",
      "setProviderSecret",
      "getModels",
      "addModel",
      "updateModel",
      "deleteModel",
      "getHarnesses",
      "launchHarness",
      "getSessions",
      "deleteSession",
      "renameSession",
      "getProxyStatus",
      "getRunnerSocketUrl",
      "getTerminalSocketUrl",
      "getUpdateSocketUrl",
      "resolveTerminalCwd",
      "getRunEvents",
      "pickFolder",
      "pickUploads",
      "saveDroppedUploads",
      "openExternalUrl",
      "openUploadExternal",
      "readUploadDataUrl",
      "readUploadThumbnail",
      "listProviderModels",
      "testProviderDraft",
      "listProviderModelsDraft",
      "getSettings",
      "getTimeoutSettings",
      "updateTimeoutSettings",
      "getSessionNamingSettings",
      "updateSessionNamingSettings",
      "getProjects",
      "setCollapsedProjects",
      "deleteProject",
      "resetApp",
      "updateHarnessPrefs",
      "getUpdateState",
      "checkForUpdate",
      "startUpdateDownload",
      "applyUpdate",
      "dismissUpdate",
      "setUpdateChannel",
      "logClientError",
    ] as const
    for (const name of expected) {
      expect(IpcMethodSchemas[name]).toBeDefined()
      expect(IpcMethodSchemas[name].params).toBeDefined()
      expect(IpcMethodSchemas[name].result).toBeDefined()
    }
    // Bidirectional roster guard: the map and the documented roster must match
    // exactly, so adding a method to either without the other fails this test.
    expect(new Set(Object.keys(IpcMethodSchemas))).toEqual(new Set(expected))
  })
})

describe("logClientError IPC schema", () => {
  it("accepts a valid client error", () => {
    expect(
      IpcMethodSchemas.logClientError.params.safeParse({
        scope: "webview.ErrorBoundary",
        level: "error",
        msg: "render crash",
        fields: { component: "RunView" },
      }).success,
    ).toBe(true)
  })
  it("rejects an invalid level", () => {
    expect(
      IpcMethodSchemas.logClientError.params.safeParse({
        scope: "x",
        level: "loud",
        msg: "y",
      }).success,
    ).toBe(false)
  })
  it("encodes the result as null", () => {
    expect(IpcMethodSchemas.logClientError.result.safeParse(null).success).toBe(
      true,
    )
  })
})

describe("UpdateHarnessPrefsParamsSchema", () => {
  it("accepts a harnessId with an optional mode and rejects an unknown mode", () => {
    expect(
      UpdateHarnessPrefsParamsSchema.safeParse({ harnessId: "claude" }).success,
    ).toBe(true)
    expect(
      UpdateHarnessPrefsParamsSchema.safeParse({
        harnessId: "claude",
        mode: "plan",
      }).success,
    ).toBe(true)
    expect(
      UpdateHarnessPrefsParamsSchema.safeParse({
        harnessId: "claude",
        mode: "yolo",
      }).success,
    ).toBe(false)
  })
  it("accepts a harnessId with an optional modelId (real id or empty string for default/clear)", () => {
    expect(
      UpdateHarnessPrefsParamsSchema.safeParse({
        harnessId: "claude",
        modelId: "mdl_x",
      }).success,
    ).toBe(true)
    expect(
      UpdateHarnessPrefsParamsSchema.safeParse({
        harnessId: "claude",
        modelId: "",
      }).success,
    ).toBe(true)
  })
  it("rejects a non-string modelId (modelId is a plain string, not ModelIdSchema)", () => {
    expect(
      UpdateHarnessPrefsParamsSchema.safeParse({
        harnessId: "claude",
        modelId: 42,
      }).success,
    ).toBe(false)
  })
})

describe("delete + reset IPC schemas", () => {
  it("accepts a valid deleteSession param", () => {
    expect(
      IpcMethodSchemas.deleteSession.params.safeParse({ sessionId: "s_1" })
        .success,
    ).toBe(true)
  })
  it("rejects a deleteSession param missing sessionId", () => {
    expect(IpcMethodSchemas.deleteSession.params.safeParse({}).success).toBe(
      false,
    )
  })
  it("accepts a valid deleteProject param", () => {
    expect(
      IpcMethodSchemas.deleteProject.params.safeParse({ projectId: "prj_1" })
        .success,
    ).toBe(true)
  })
  it("treats resetApp params as undefined (no args)", () => {
    expect(IpcMethodSchemas.resetApp.params.safeParse(undefined).success).toBe(
      true,
    )
  })
  it("encodes deleteSession/deleteProject/resetApp results as null (void)", () => {
    expect(IpcMethodSchemas.deleteSession.result.safeParse(null).success).toBe(
      true,
    )
    expect(IpcMethodSchemas.deleteProject.result.safeParse(null).success).toBe(
      true,
    )
    expect(IpcMethodSchemas.resetApp.result.safeParse(null).success).toBe(true)
  })
})

describe("getProviderCatalog method", () => {
  it("is registered with a params + result schema", () => {
    expect(IpcMethodSchemas.getProviderCatalog).toBeDefined()
  })

  it("validates a catalog array result", () => {
    const r = IpcMethodSchemas.getProviderCatalog.result.safeParse([
      {
        key: "custom",
        label: "Custom (OpenAI-compatible)",
        configFields: [],
        secretFields: [],
        supportsCustomHeaders: true,
      },
    ])
    expect(r.success).toBe(true)
  })
})

describe("SaveDroppedUploadsParamsSchema", () => {
  it("accepts a dropped-file batch with an empty mime (unknown type)", () => {
    const parsed = SaveDroppedUploadsParamsSchema.safeParse({
      files: [{ displayName: "a.png", mime: "", dataBase64: "aGVsbG8=" }],
      acceptedKinds: ["image"],
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects an empty files array and a missing dataBase64", () => {
    expect(
      SaveDroppedUploadsParamsSchema.safeParse({
        files: [],
        acceptedKinds: ["image"],
      }).success,
    ).toBe(false)
    expect(
      SaveDroppedUploadsParamsSchema.safeParse({
        files: [{ displayName: "a.png", mime: "image/png", dataBase64: "" }],
        acceptedKinds: ["image"],
      }).success,
    ).toBe(false)
  })

  it("rejects a dataBase64 that is not valid base64", () => {
    const parsed = SaveDroppedUploadsParamsSchema.safeParse({
      files: [
        {
          displayName: "a.png",
          mime: "image/png",
          dataBase64: "not base64!!",
        },
      ],
      acceptedKinds: ["image"],
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a dataBase64 longer than the MAX_UPLOAD_BYTES-derived ceiling", () => {
    // The schema's ceiling is Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4 (base64
    // length for a MAX_UPLOAD_BYTES file, +4 slack). Adding 4 more keeps the
    // string a multiple of 4 (so it is still shaped like valid base64 and
    // fails ONLY the length check, not the base64-format check).
    const ceiling = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4
    const overLimit = "A".repeat(ceiling + 4)
    const parsed = SaveDroppedUploadsParamsSchema.safeParse({
      files: [
        { displayName: "a.png", mime: "image/png", dataBase64: overLimit },
      ],
      acceptedKinds: ["image"],
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts a large legitimate dataBase64 payload at the MAX_UPLOAD_BYTES size", () => {
    // Regression guard: zod's built-in z.string().base64() (considered, not
    // used — see methods.ts) silently rejects well-formed base64 once it
    // gets long on Bun's JavaScriptCore. A real MAX_UPLOAD_BYTES-sized
    // upload must be ACCEPTED, not just malformed/oversized ones rejected.
    const bytes = Buffer.alloc(MAX_UPLOAD_BYTES)
    const parsed = SaveDroppedUploadsParamsSchema.safeParse({
      files: [
        {
          displayName: "big.bin",
          mime: "application/octet-stream",
          dataBase64: bytes.toString("base64"),
        },
      ],
      acceptedKinds: ["binary"],
    })
    expect(parsed.success).toBe(true)
  })
})

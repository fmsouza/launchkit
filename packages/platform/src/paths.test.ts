import { describe, expect, it } from "bun:test"
import { resolveAppPaths } from "./paths"

const env = (e: Record<string, string | undefined> = {}) => e

describe("resolveAppPaths", () => {
  it("uses ~/Library/Application Support/Spectrum on macOS", () => {
    const p = resolveAppPaths({
      platform: "macos",
      homeDir: "/Users/me",
      env: env(),
    })
    expect(p.dataDir).toBe("/Users/me/Library/Application Support/Spectrum")
    expect(p.configFile).toBe(
      "/Users/me/Library/Application Support/Spectrum/config.json",
    )
    expect(p.dbFile).toBe(
      "/Users/me/Library/Application Support/Spectrum/spectrum.db",
    )
    expect(p.harnessDir).toBe(
      "/Users/me/Library/Application Support/Spectrum/harnesses",
    )
    expect(p.runtimeFile).toBe(
      "/Users/me/Library/Application Support/Spectrum/runtime.json",
    )
    expect(p.secretsDir).toBe(
      "/Users/me/Library/Application Support/Spectrum/secrets",
    )
  })

  it("uses ~/.config/spectrum on Linux when XDG_CONFIG_HOME is unset", () => {
    const p = resolveAppPaths({
      platform: "linux",
      homeDir: "/home/me",
      env: env(),
    })
    expect(p.dataDir).toBe("/home/me/.config/spectrum")
    expect(p.configFile).toBe("/home/me/.config/spectrum/config.json")
  })

  it("honors XDG_CONFIG_HOME on Linux when it is set", () => {
    const p = resolveAppPaths({
      platform: "linux",
      homeDir: "/home/me",
      env: env({ XDG_CONFIG_HOME: "/cfg" }),
    })
    expect(p.dataDir).toBe("/cfg/spectrum")
  })

  it("uses %APPDATA%\\Spectrum on Windows when APPDATA is set", () => {
    const p = resolveAppPaths({
      platform: "windows",
      homeDir: "C:\\Users\\me",
      env: env({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }),
    })
    expect(p.dataDir).toBe("C:\\Users\\me\\AppData\\Roaming\\Spectrum")
    expect(p.configFile).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\Spectrum\\config.json",
    )
  })

  it("falls back to ~/AppData/Roaming on Windows when APPDATA is unset", () => {
    const p = resolveAppPaths({
      platform: "windows",
      homeDir: "C:\\Users\\me",
      env: env(),
    })
    expect(p.dataDir).toBe("C:\\Users\\me\\AppData\\Roaming\\Spectrum")
  })

  it("honors the SPECTRUM_DATA_DIR override on every platform", () => {
    const p = resolveAppPaths({
      platform: "linux",
      homeDir: "/home/me",
      env: env({ SPECTRUM_DATA_DIR: "/custom/dir" }),
    })
    expect(p.dataDir).toBe("/custom/dir")
    expect(p.dbFile).toBe("/custom/dir/spectrum.db")
  })

  it("uses 'Spectrum (Dev)' on macOS when appEnv is development", () => {
    const p = resolveAppPaths({
      platform: "macos",
      homeDir: "/Users/me",
      env: env(),
      appEnv: "development",
    })
    expect(p.dataDir).toBe(
      "/Users/me/Library/Application Support/Spectrum (Dev)",
    )
    expect(p.dbFile).toBe(
      "/Users/me/Library/Application Support/Spectrum (Dev)/spectrum.db",
    )
    expect(p.secretsDir).toBe(
      "/Users/me/Library/Application Support/Spectrum (Dev)/secrets",
    )
  })

  it("uses 'spectrum-dev' on Linux when appEnv is development", () => {
    const p = resolveAppPaths({
      platform: "linux",
      homeDir: "/home/me",
      env: env(),
      appEnv: "development",
    })
    expect(p.dataDir).toBe("/home/me/.config/spectrum-dev")
  })

  it("uses 'Spectrum (Dev)' on Windows when appEnv is development", () => {
    const p = resolveAppPaths({
      platform: "windows",
      homeDir: "C:\\Users\\me",
      env: env({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }),
      appEnv: "development",
    })
    expect(p.dataDir).toBe("C:\\Users\\me\\AppData\\Roaming\\Spectrum (Dev)")
  })

  it("defaults to the production dir when appEnv is omitted", () => {
    const p = resolveAppPaths({
      platform: "macos",
      homeDir: "/Users/me",
      env: env(),
    })
    expect(p.dataDir).toBe("/Users/me/Library/Application Support/Spectrum")
  })

  it("lets SPECTRUM_DATA_DIR override even in development", () => {
    const p = resolveAppPaths({
      platform: "linux",
      homeDir: "/home/me",
      env: env({ SPECTRUM_DATA_DIR: "/custom/dir" }),
      appEnv: "development",
    })
    expect(p.dataDir).toBe("/custom/dir")
  })

  it("uses 'Spectrum (Canary)' on macOS when channel is canary", () => {
    const p = resolveAppPaths({
      platform: "macos",
      homeDir: "/Users/me",
      env: {},
      channel: "canary",
    })
    expect(p.dataDir).toBe(
      "/Users/me/Library/Application Support/Spectrum (Canary)",
    )
    expect(p.runtimeFile).toBe(
      "/Users/me/Library/Application Support/Spectrum (Canary)/runtime.json",
    )
  })
  it("uses 'spectrum-canary' on Linux when channel is canary", () => {
    const p = resolveAppPaths({
      platform: "linux",
      homeDir: "/home/me",
      env: {},
      channel: "canary",
    })
    expect(p.dataDir).toBe("/home/me/.config/spectrum-canary")
  })

  it("resolveAppPaths includes uploadsDir under dataDir", () => {
    const paths = resolveAppPaths({
      platform: "macos",
      homeDir: "/Users/me",
      env: {},
    })
    expect(paths.uploadsDir).toBe(`${paths.dataDir}/uploads`)
  })
})

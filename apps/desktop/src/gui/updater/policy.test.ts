import { describe, expect, it } from "bun:test"
import { decideBanner } from "./policy"

describe("decideBanner", () => {
  it("hides when no update is available", () => {
    expect(
      decideBanner({
        available: false,
        latestVersion: null,
        latestHash: null,
        dismissedVersion: null,
        dismissedHash: null,
      }),
    ).toBe("hidden")
  })

  it("hides when no update is available", () => {
    expect(
      decideBanner({
        available: false,
        latestVersion: null,
        latestHash: null,
        dismissedVersion: null,
        dismissedHash: null,
      }),
    ).toBe("hidden")
  })

  it("shows when an update is available and nothing was dismissed", () => {
    expect(
      decideBanner({
        available: true,
        latestVersion: "1.2.0",
        latestHash: null,
        dismissedVersion: null,
        dismissedHash: null,
      }),
    ).toBe("show")
  })

  it("hides when the available version equals the dismissed version", () => {
    expect(
      decideBanner({
        available: true,
        latestVersion: "1.2.0",
        latestHash: null,
        dismissedVersion: "1.2.0",
        dismissedHash: null,
      }),
    ).toBe("hidden")
  })

  it("shows again when a newer version supersedes the dismissed one", () => {
    expect(
      decideBanner({
        available: true,
        latestVersion: "1.3.0",
        latestHash: null,
        dismissedVersion: "1.2.0",
        dismissedHash: null,
      }),
    ).toBe("show")
  })

  it("hides when available is true but latestVersion is null (defensive)", () => {
    expect(
      decideBanner({
        available: true,
        latestVersion: null,
        latestHash: null,
        dismissedVersion: null,
        dismissedHash: null,
      }),
    ).toBe("hidden")
  })

  it("hides when the latest hash equals the dismissed hash", () => {
    expect(
      decideBanner({
        available: true,
        latestVersion: "1.4.0",
        latestHash: "1wg7wj2g0bm4w",
        dismissedVersion: null,
        dismissedHash: "1wg7wj2g0bm4w",
      }),
    ).toBe("hidden")
  })

  it("shows again when a newer build hash supersedes the dismissed hash, even if the version string is unchanged", () => {
    // The canary regression: canary CI never bumps package.json version, so
    // every canary reports the same `latestVersion`. Keying dismissal on the
    // build hash means a new canary (different hash, same version) re-shows.
    expect(
      decideBanner({
        available: true,
        latestVersion: "1.4.0",
        latestHash: "2bbbbbbbbbbbb",
        dismissedVersion: "1.4.0",
        dismissedHash: "1wg7wj2g0bm4w",
      }),
    ).toBe("show")
  })

  it("falls back to version comparison when latestHash is null", () => {
    // An older bundle that didn't surface a build hash must keep behaving by
    // the legacy version-keyed dismissal so existing users don't regress.
    expect(
      decideBanner({
        available: true,
        latestVersion: "1.2.0",
        latestHash: null,
        dismissedVersion: "1.2.0",
        dismissedHash: null,
      }),
    ).toBe("hidden")
    expect(
      decideBanner({
        available: true,
        latestVersion: "1.3.0",
        latestHash: null,
        dismissedVersion: "1.2.0",
        dismissedHash: null,
      }),
    ).toBe("show")
  })
})

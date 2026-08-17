import { describe, expect, it } from "bun:test"
import { idFromSource, planInstall } from "./plan-install"

const base = {
  pluginRoot: "/data/providers",
  existingIds: [] as readonly string[],
  platform: "macos" as const,
}

describe("idFromSource", () => {
  it("derives a slug from an https url ending in .git", () => {
    expect(idFromSource("https://example.com/me/acme-provider.git")).toBe(
      "acme-provider",
    )
  })

  it("derives a slug from an ssh url with no .git suffix", () => {
    expect(idFromSource("git@example.com:me/acme-provider")).toBe(
      "acme-provider",
    )
  })

  it("derives a slug from a local directory's final segment", () => {
    expect(idFromSource("/home/me/work/Acme_Provider")).toBe("acme-provider")
  })

  it("returns undefined when the source has no usable final segment", () => {
    expect(idFromSource("https://example.com/")).toBeUndefined()
  })

  it("returns undefined when the final segment slugifies to nothing", () => {
    expect(idFromSource("/home/me/___")).toBeUndefined()
  })
})

describe("planInstall — git", () => {
  it("derives id, read dir, and write dir when given an https url", () => {
    const r = planInstall({
      ...base,
      source: "https://example.com/me/acme.git",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(String(r.value.id)).toBe("acme")
      expect(r.value.readDir).toBe("/data/providers/acme")
      expect(r.value.writeDir).toBe("/data/providers/acme")
      expect(r.value.source).toEqual({
        kind: "git",
        url: "https://example.com/me/acme.git",
        ref: "HEAD",
      })
    }
  })

  it("honours an explicit ref when one is supplied", () => {
    const r = planInstall({
      ...base,
      source: "https://example.com/me/acme.git",
      ref: "v2.0.0",
    })
    expect(r.ok).toBe(true)
    if (r.ok && r.value.source.kind === "git")
      expect(r.value.source.ref).toBe("v2.0.0")
  })

  it("accepts an scp-style ssh source", () => {
    const r = planInstall({ ...base, source: "git@example.com:me/acme.git" })
    expect(r.ok).toBe(true)
    if (r.ok && r.value.source.kind === "git")
      expect(r.value.source.url).toBe("git@example.com:me/acme.git")
  })

  it("rejects a source whose scheme is neither https, ssh, nor an absolute path", () => {
    const r = planInstall({ ...base, source: "file:///etc/passwd", id: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("rejects a plain http git url so a clone is never fetched in the clear", () => {
    const r = planInstall({ ...base, source: "http://example.com/me/acme.git" })
    expect(r.ok).toBe(false)
  })

  it("refuses an https url embedding a user:pass credential", () => {
    const r = planInstall({
      ...base,
      source: "https://user:pass@example.com/me/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid-manifest")
      if (r.error.kind === "invalid-manifest")
        expect(r.error.detail).not.toContain("pass")
    }
  })

  it("refuses an https url embedding a bare token credential", () => {
    const r = planInstall({
      ...base,
      source: "https://ghp_supersecrettoken@example.com/me/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid-manifest")
      if (r.error.kind === "invalid-manifest")
        expect(r.error.detail).not.toContain("ghp_supersecrettoken")
    }
  })

  it("accepts an ssh:// url with a git@ username, which is not a credential", () => {
    const r = planInstall({
      ...base,
      source: "ssh://git@example.com/me/acme.git",
    })
    expect(r.ok).toBe(true)
  })

  it("refuses an ssh:// url whose userinfo embeds a password", () => {
    const r = planInstall({
      ...base,
      source: "ssh://git:hunter2@example.com/me/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid-manifest")
      if (r.error.kind === "invalid-manifest")
        expect(r.error.detail).not.toContain("hunter2")
    }
  })

  it("accepts an ssh:// url with a bare user@ and no password", () => {
    const r = planInstall({
      ...base,
      source: "ssh://deploy@example.com/me/acme.git",
    })
    expect(r.ok).toBe(true)
  })

  it("accepts an scp-style url with a git@ username, which is not a credential", () => {
    const r = planInstall({ ...base, source: "git@example.com:me/acme.git" })
    expect(r.ok).toBe(true)
  })
})

describe("planInstall — path", () => {
  it("defaults to link mode when given an absolute path", () => {
    const r = planInstall({ ...base, source: "/home/me/acme" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.source).toEqual({
        kind: "path",
        path: "/home/me/acme",
        linked: true,
      })
      expect(r.value.readDir).toBe("/home/me/acme")
      expect(r.value.writeDir).toBeUndefined()
    }
  })

  it("reads from and writes to the plugin root when mode is copy", () => {
    const r = planInstall({ ...base, source: "/home/me/acme", mode: "copy" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.source).toEqual({
        kind: "path",
        path: "/home/me/acme",
        linked: false,
      })
      expect(r.value.readDir).toBe("/data/providers/acme")
      expect(r.value.writeDir).toBe("/data/providers/acme")
    }
  })

  it("rejects a relative path because it is ambiguous against the app's cwd", () => {
    expect(planInstall({ ...base, source: "./acme", id: "acme" }).ok).toBe(
      false,
    )
  })

  it("rejects a path containing a parent-directory segment", () => {
    expect(
      planInstall({ ...base, source: "/home/me/../acme", id: "acme" }).ok,
    ).toBe(false)
  })

  it("rejects link mode when the path is inside the plugin root", () => {
    const r = planInstall({ ...base, source: "/data/providers/acme" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("plans a windows path against the win32 separator when the platform is windows", () => {
    const r = planInstall({
      source: "C:\\Users\\me\\acme",
      pluginRoot: "C:\\data\\providers",
      existingIds: [],
      platform: "windows",
      mode: "copy",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.writeDir).toBe("C:\\data\\providers\\acme")
  })

  it("rejects a link whose path differs from the plugin root only in case, on macos", () => {
    const r = planInstall({
      ...base,
      source: "/data/Providers/acme",
      platform: "macos",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("rejects a link whose path differs from the plugin root only in case, on windows", () => {
    const r = planInstall({
      source: "C:\\Data\\Providers\\acme",
      pluginRoot: "C:\\data\\providers",
      existingIds: [],
      platform: "windows",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("accepts a link whose path differs from the plugin root only in case, on linux", () => {
    const r = planInstall({
      ...base,
      source: "/data/Providers/acme",
      platform: "linux",
    })
    expect(r.ok).toBe(true)
  })
})

describe("planInstall — shared", () => {
  it("honours an explicit id when one is supplied", () => {
    const r = planInstall({
      ...base,
      source: "https://example.com/me/acme.git",
      id: "custom-name",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(String(r.value.id)).toBe("custom-name")
      expect(r.value.readDir).toBe("/data/providers/custom-name")
    }
  })

  it("rejects an explicit id that is not a lowercase slug", () => {
    expect(
      planInstall({ ...base, source: "/home/me/acme", id: "../escape" }).ok,
    ).toBe(false)
  })

  it("rejects an explicit id containing a path separator", () => {
    expect(
      planInstall({ ...base, source: "/home/me/acme", id: "a/b" }).ok,
    ).toBe(false)
  })

  it("fails with invalid-manifest when no id can be derived and none was given", () => {
    const r = planInstall({ ...base, source: "https://example.com/" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-manifest")
  })

  it("rejects the plan with duplicate-id when the id is already installed", () => {
    const r = planInstall({
      ...base,
      existingIds: ["acme"],
      source: "https://example.com/me/acme.git",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("duplicate-id")
  })
})

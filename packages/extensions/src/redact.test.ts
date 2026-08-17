import { describe, expect, it } from "bun:test"
import { redactUrlCredentials } from "./redact"

describe("redactUrlCredentials", () => {
  it("redacts a user:pass@ credential", () => {
    expect(redactUrlCredentials("https://user:pass@example.com/x.git")).toBe(
      "https://[REDACTED]@example.com/x.git",
    )
  })

  it("redacts a bare token@ credential", () => {
    expect(redactUrlCredentials("https://ghp_abc123@example.com/x.git")).toBe(
      "https://[REDACTED]@example.com/x.git",
    )
  })

  it("redacts the full password even when it contains an embedded @", () => {
    const url = "https://user:p@ssw0rd@example.com/x.git"
    const redacted = redactUrlCredentials(url)
    expect(redacted).toBe("https://[REDACTED]@example.com/x.git")
    expect(redacted).not.toContain("ssw0rd")
  })

  it("redacts an ssh:// git@ username, harmlessly", () => {
    expect(redactUrlCredentials("ssh://git@example.com/me/x.git")).toBe(
      "ssh://[REDACTED]@example.com/me/x.git",
    )
  })

  /** A bare scp-style username is not a secret, and blanking it would make an otherwise
   * legible error message useless. */
  it("leaves a bare scp-style git@ username untouched", () => {
    const url = "git@example.com:me/x.git"
    expect(redactUrlCredentials(url)).toBe(url)
  })

  it("redacts an scp-style user:pass@ credential", () => {
    expect(redactUrlCredentials("git:hunter2@example.com:me/x.git")).toBe(
      "[REDACTED]@example.com:me/x.git",
    )
  })

  it("redacts a full scp-style password even when it contains an embedded @", () => {
    const redacted = redactUrlCredentials("git:p@ssw0rd@example.com:me/x.git")
    expect(redacted).toBe("[REDACTED]@example.com:me/x.git")
    expect(redacted).not.toContain("ssw0rd")
  })

  it("leaves a url with no userinfo untouched", () => {
    const url = "https://example.com/me/x.git"
    expect(redactUrlCredentials(url)).toBe(url)
  })
})

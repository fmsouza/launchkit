/**
 * Strips an embedded `user:pass@` or bare `token@` credential segment from a url before it
 * ever reaches a log line or an error detail (Global Constraint 10: never log or persist a
 * url without stripping it first). This is the ONE redactor in the package — `git.ts`,
 * `plan-install.ts`, and `installer.ts` all import it rather than each growing their own;
 * two independent redactors is how one of them silently stops matching.
 */
export const redactUrlCredentials = (url: string): string =>
  // Greedy up to the LAST `@` before the next `/` (or end of string): a password itself may
  // contain `@` (`user:p@ssw0rd@host`), and excluding `@` from the character class — as an
  // earlier version of this regex did — stops at the FIRST `@`, leaving the password tail
  // unredacted. Requiring a leading `//` means a scp-style source (`git@host:path`, no `//`)
  // is never matched by this first regex at all — that form is handled below.
  url
    .replace(/\/\/[^/\s]+@/, "//[REDACTED]@")
    // The scp form (`user:pass@host:path`) has no `//` to anchor on, and it reaches
    // `config.json`, IPC and CLI output the same as any other source url. Only a userinfo
    // containing `:` is redacted: a bare `git@host:path` username is not a secret, and
    // blanking it would make an otherwise legible message useless. The leading group forbids
    // `@` so the split lands on the FIRST `@` (the userinfo boundary) while the greedy tail
    // still swallows a password's own embedded `@`s.
    .replace(/^[^/\s@]*:[^/\s]*@/, "[REDACTED]@")

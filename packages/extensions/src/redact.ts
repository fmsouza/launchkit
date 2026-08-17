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
  // is never touched by this regex at all.
  url.replace(/\/\/[^/\s]+@/, "//[REDACTED]@")

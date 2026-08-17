/**
 * Strips an embedded `user:pass@` or bare `token@` credential segment from a url before it
 * ever reaches a log line or an error detail (Global Constraint 10: never log or persist a
 * url without stripping it first). This is the ONE redactor in the package — `git.ts`,
 * `plan-install.ts`, and `installer.ts` all import it rather than each growing their own;
 * two independent redactors is how one of them silently stops matching.
 */
export const redactUrlCredentials = (url: string): string =>
  url.replace(/\/\/[^/@\s]+@/, "//[REDACTED]@")

/**
 * Every regex below runs on a user-supplied install source, so each one must be linear in
 * the input's length (CodeQL `js/polynomial-redos`; guarded by the timing block in
 * `redact.test.ts`). `@` and `:` are themselves members of `[^/\s]`, so the obvious spelling
 * of each of these — `[^/\s]+@`, `[^/\s]+:` — lets a run of `@`s or `:`s be split between
 * the class and its delimiter in many ways, and the engine tries them all. Each pattern is
 * therefore written so exactly one split of any given input is possible: a class never
 * contains the delimiter that follows it, and where the old pattern was deliberately greedy
 * to the LAST `@`, that greed is expressed as `(?:[^/\s@]*@)+` — a repetition whose every
 * iteration must consume an `@`, which is unambiguous for the same reason. Keep that
 * property when editing; the matched LANGUAGE of each regex is unchanged.
 */

/** An scp-style git source: `user@host:path` — no scheme, and no `/` before the `:`.
 * Declared here rather than in `plan-install.ts` (which imports it) so the module that
 * REFUSES a credentialed source and the module that REDACTS one agree on what the scp form
 * is by construction; two independent shape regexes is how one of them silently stops
 * matching.
 *
 * Anchors on the FIRST `@` at index >= 1 and then the first `:` at least two characters
 * past it. That is the same language as the ambiguous `^[^/\s]+@[^/\s]+:.+$`: `@` and `:`
 * both belong to `[^/\s]`, so every character before the `:` must be in that class either
 * way, and choosing the earliest legal `@`/`:` only ever lengthens a tail whose characters
 * the prefix already proved are neither `/` nor whitespace. */
export const SCP_STYLE = /^[^/\s][^/\s@]*@[^/\s][^/\s:]*:.+$/

/** Any userinfo on an `http(s)://` url is a secret — a bare `token@host` is the common
 * GitHub PAT form, so unlike ssh there is no innocent username case to preserve. Greedy up
 * to the LAST `@` before the next `/`: a password may itself contain `@`
 * (`user:p@ssw0rd@host`), and a non-greedy match would leave the password's tail exposed.
 * The leading `[^/\s]` is what the old `[^/\s]+@`'s `+` provided: at least one character
 * must precede the final `@`, so `https://@host` is userinfo-free as it was before. */
const HTTP_USERINFO = /^(https?:\/\/)[^/\s](?:[^/\s@]*@)+/i

/** Any other scheme (`ssh://`, `git://`, …) leaks only when the userinfo carries a
 * PASSWORD. A bare `ssh://git@host` username is not a secret — SSH authenticates by key,
 * and `plan-install.ts` accepts that form for exactly that reason — so redacting it would
 * make an error message useless while protecting nothing. */
const URL_PASSWORD_USERINFO =
  /^([a-z][a-z0-9+.-]*:\/\/)[^/\s@:]*:(?:[^/\s@]*@)+/i

/** The scp form's password, on the same rule as `URL_PASSWORD_USERINFO`. Only applied to a
 * string that is an scp source in full (`SCP_STYLE`): without that gate, any `x:y@z` — a
 * Windows path such as `C:\Users\me\plug@ins`, which reaches here as a git argv element —
 * would be mangled into `[REDACTED]@ins`. */
const SCP_PASSWORD_USERINFO = /^[^/\s@:]*:(?:[^/\s@]*@)+/

/**
 * Strips an embedded credential from a source url before it ever reaches a log line or an
 * error detail (Global Constraint 10: never log or persist a url without stripping it
 * first). This is the ONE redactor in the package — `git.ts`, `plan-install.ts`, and
 * `installer.ts` all import it rather than each growing their own.
 *
 * Its rules mirror `plan-install.ts`'s refusals exactly, per url shape: whatever that module
 * calls a credential, this one redacts, and whatever it calls a bare username, this one
 * leaves alone. Anchored at the start of the string: every caller passes one whole url or
 * one whole argv element, never a joined command line.
 */
export const redactUrlCredentials = (url: string): string => {
  if (HTTP_USERINFO.test(url))
    return url.replace(HTTP_USERINFO, "$1[REDACTED]@")
  if (URL_PASSWORD_USERINFO.test(url))
    return url.replace(URL_PASSWORD_USERINFO, "$1[REDACTED]@")
  if (SCP_STYLE.test(url))
    return url.replace(SCP_PASSWORD_USERINFO, "[REDACTED]@")
  return url
}

/** An scp-style git source: `user@host:path` — no scheme, and no `/` before the `:`.
 * Declared here rather than in `plan-install.ts` (which imports it) so the module that
 * REFUSES a credentialed source and the module that REDACTS one agree on what the scp form
 * is by construction; two independent shape regexes is how one of them silently stops
 * matching. */
export const SCP_STYLE = /^[^/\s]+@[^/\s]+:.+$/

/** Any userinfo on an `http(s)://` url is a secret — a bare `token@host` is the common
 * GitHub PAT form, so unlike ssh there is no innocent username case to preserve. Greedy up
 * to the LAST `@` before the next `/`: a password may itself contain `@`
 * (`user:p@ssw0rd@host`), and a non-greedy match would leave the password's tail exposed. */
const HTTP_USERINFO = /^(https?:\/\/)[^/\s]+@/i

/** Any other scheme (`ssh://`, `git://`, …) leaks only when the userinfo carries a
 * PASSWORD. A bare `ssh://git@host` username is not a secret — SSH authenticates by key,
 * and `plan-install.ts` accepts that form for exactly that reason — so redacting it would
 * make an error message useless while protecting nothing. */
const URL_PASSWORD_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/\s@:]*:[^/\s]*@/i

/** The scp form's password, on the same rule as `URL_PASSWORD_USERINFO`. Only applied to a
 * string that is an scp source in full (`SCP_STYLE`): without that gate, any `x:y@z` — a
 * Windows path such as `C:\Users\me\plug@ins`, which reaches here as a git argv element —
 * would be mangled into `[REDACTED]@ins`. */
const SCP_PASSWORD_USERINFO = /^[^/\s@:]*:[^/\s]*@/

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

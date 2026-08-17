import path from "node:path"
import {
  type Platform,
  detectPlatform,
  isAbsolutePath,
} from "@spectrum/platform"
import { type PluginId, PluginIdSchema } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { PluginError } from "./errors"
import { SCP_STYLE, redactUrlCredentials } from "./redact"

export type InstallMode = "link" | "copy"

export type PlannedSource =
  | { readonly kind: "git"; readonly url: string; readonly ref: string }
  | { readonly kind: "path"; readonly path: string; readonly linked: boolean }

export type InstallPlan = {
  readonly id: PluginId
  readonly source: PlannedSource
  readonly readDir: string
  readonly writeDir: string | undefined
}

export type PlanInstallInput = {
  readonly source: string
  readonly ref?: string
  readonly id?: string
  readonly mode?: InstallMode
  readonly pluginRoot: string
  readonly existingIds: readonly string[]
  readonly platform?: Platform
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** Matches an `https://` url carrying userinfo (`user:pass@` or a bare `token@`) before the
 * host. `ssh://git@host/...` and scp-style `git@host:path` are NOT matched — `git@` there is
 * a username, not a secret, since SSH authenticates by key. Only `https://` carries a secret
 * in the url itself. */
const HTTPS_CREDENTIALS = /^https:\/\/[^/\s]*@/i

const hasEmbeddedHttpsCredentials = (source: string): boolean =>
  HTTPS_CREDENTIALS.test(source)

const SSH_PREFIX = "ssh://"

/**
 * `ssh://user@host` is a bare username — SSH authenticates by key, so that carries no
 * secret. `ssh://user:pass@host` is different: the `:` before the `@` is a password, and
 * unlike `https://` (refused outright above), the SSH form is common enough with a plain
 * username that we don't want to refuse the whole scheme — only the password case.
 */
const hasSshPasswordUserinfo = (source: string): boolean => {
  if (!source.startsWith(SSH_PREFIX)) return false
  const rest = source.slice(SSH_PREFIX.length)
  const atIndex = rest.indexOf("@")
  if (atIndex === -1) return false
  const userinfo = rest.slice(0, atIndex)
  return userinfo.includes(":")
}

/**
 * The scp form (`user@host:path`) is the third place a password can hide, and the mirror of
 * `hasSshPasswordUserinfo`: same rule (a `:` in the segment before the FIRST `@` is a
 * password), same refusal. A bare `git@host:path` username is not a secret — SSH
 * authenticates by key — so only the password case is refused.
 */
const hasScpPasswordUserinfo = (source: string): boolean => {
  if (!SCP_STYLE.test(source)) return false
  const atIndex = source.indexOf("@")
  return source.slice(0, atIndex).includes(":")
}

/**
 * Splits a source's final path-like segment. For a `scheme://` url or an scp-style
 * `user@host:path`, the host is not a candidate segment — only what follows it is.
 */
const finalSegment = (source: string): string | undefined => {
  if (URL_SCHEME.test(source)) {
    const withoutScheme = source.replace(URL_SCHEME, "")
    const segments = withoutScheme.split("/").filter((p) => p.length > 0)
    // Need a path segment beyond the host; a bare host has nothing to derive an id from.
    return segments.length >= 2 ? segments.at(-1) : undefined
  }
  if (SCP_STYLE.test(source)) {
    const afterHost = source.slice(source.indexOf(":") + 1)
    const segments = afterHost.split("/").filter((p) => p.length > 0)
    return segments.at(-1)
  }
  const segments = source.split(/[/\\]+/).filter((p) => p.length > 0)
  return segments.at(-1)
}

/** Slugifies a candidate id: lowercase, non-`[a-z0-9]` runs become `-`, trimmed, `undefined` if empty. */
const slugify = (candidate: string): string | undefined => {
  const withoutGit = candidate.replace(/\.git$/, "")
  const slug = withoutGit
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : undefined
}

/** Derives a plugin id slug from a git URL or local path's final segment. */
export const idFromSource = (source: string): string | undefined => {
  const segment = finalSegment(source)
  if (segment === undefined) return undefined
  return slugify(segment)
}

const hasParentSegment = (source: string): boolean =>
  source.split(/[/\\]/).includes("..")

const isGitUrl = (source: string): boolean =>
  source.startsWith("https://") ||
  source.startsWith("ssh://") ||
  SCP_STYLE.test(source)

/** Normalises trailing separators so containment comparisons aren't fooled by them. */
const stripTrailingSep = (p: string, sep: string): string =>
  p.endsWith(sep) ? p.slice(0, -sep.length) : p

/**
 * macOS (APFS default) and Windows (NTFS default) volumes are case-insensitive, so two paths
 * differing only in case are the same directory there — fold case before comparing. Linux
 * filesystems are case-sensitive, so such paths are genuinely distinct and must not be folded.
 */
const isContainedIn = (
  candidate: string,
  root: string,
  pathImpl: typeof path.win32,
  platform: Platform,
): boolean => {
  const fold = (s: string): string =>
    platform === "linux" ? s : s.toLowerCase()
  const normCandidate = fold(
    stripTrailingSep(pathImpl.normalize(candidate), pathImpl.sep),
  )
  const normRoot = fold(
    stripTrailingSep(pathImpl.normalize(root), pathImpl.sep),
  )
  return (
    normCandidate === normRoot ||
    normCandidate.startsWith(normRoot + pathImpl.sep)
  )
}

const resolveId = (input: PlanInstallInput): Result<PluginId, PluginError> => {
  const candidate = input.id ?? idFromSource(input.source)
  if (candidate === undefined) {
    return err({
      kind: "invalid-manifest",
      detail: `could not derive a plugin id from source: ${redactUrlCredentials(input.source)}`,
    })
  }
  const parsed = PluginIdSchema.safeParse(candidate)
  if (!parsed.success) {
    return err({
      kind: "invalid-manifest",
      detail: `invalid plugin id: ${candidate}`,
    })
  }
  return ok(parsed.data)
}

/** Turns a user-supplied source (git URL or absolute local path) into a validated install plan. Pure. */
export const planInstall = (
  input: PlanInstallInput,
): Result<InstallPlan, PluginError> => {
  const platform = input.platform ?? detectPlatform()
  const pathImpl = platform === "windows" ? path.win32 : path.posix

  if (hasParentSegment(input.source)) {
    return err({
      kind: "invalid-manifest",
      detail: `source must not contain a parent-directory segment: ${redactUrlCredentials(input.source)}`,
    })
  }

  const idResult = resolveId(input)
  if (!idResult.ok) return idResult
  const id = idResult.value

  if (input.existingIds.includes(String(id))) {
    return err({ kind: "duplicate-id", id: String(id) })
  }

  const isPath = isAbsolutePath(input.source, platform)

  if (isPath) {
    const mode: InstallMode = input.mode ?? "link"
    const linked = mode === "link"
    const readDir = linked
      ? input.source
      : pathImpl.join(input.pluginRoot, String(id))
    const writeDir = linked
      ? undefined
      : pathImpl.join(input.pluginRoot, String(id))

    if (
      linked &&
      isContainedIn(input.source, input.pluginRoot, pathImpl, platform)
    ) {
      return err({
        kind: "invalid-manifest",
        detail: `link source must not be inside the plugin root: ${redactUrlCredentials(input.source)}`,
      })
    }

    return ok({
      id,
      source: { kind: "path", path: input.source, linked },
      readDir,
      writeDir,
    })
  }

  if (!isGitUrl(input.source)) {
    return err({
      kind: "invalid-manifest",
      detail: `source must be an absolute path, an https:// or ssh:// url, or an scp-style git source: ${redactUrlCredentials(input.source)}`,
    })
  }

  if (hasEmbeddedHttpsCredentials(input.source)) {
    return err({
      kind: "invalid-manifest",
      detail: `git url must not embed credentials — config stores this url verbatim; use an ssh:// or scp-style url, or git's own credential helper, instead: ${redactUrlCredentials(input.source)}`,
    })
  }

  if (hasSshPasswordUserinfo(input.source)) {
    return err({
      kind: "invalid-manifest",
      detail: `ssh url must not embed a password — config stores this url verbatim; use a bare ssh://user@host (key-based auth) instead: ${redactUrlCredentials(input.source)}`,
    })
  }

  if (hasScpPasswordUserinfo(input.source)) {
    return err({
      kind: "invalid-manifest",
      detail: `scp-style git source must not embed a password — config stores this url verbatim; use a bare user@host:path (key-based auth) instead: ${redactUrlCredentials(input.source)}`,
    })
  }

  const dir = pathImpl.join(input.pluginRoot, String(id))
  return ok({
    id,
    source: { kind: "git", url: input.source, ref: input.ref ?? "HEAD" },
    readDir: dir,
    writeDir: dir,
  })
}

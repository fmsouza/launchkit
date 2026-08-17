import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { PluginId } from "@spectrum/types"
import { type Result, err, ok } from "@spectrum/utils"
import type { PluginError } from "./errors"
import type { ExtensionEntry, ExtensionFileSource } from "./file-source"
import { type CaptureStdout, gitEnv } from "./git"
import { MANIFEST_FILE } from "./manifest"

/** Reject ids that are empty or could escape `root` (path separators / parent refs). */
const safeId = (id: string): Result<string, PluginError> => {
  if (id.length === 0 || id.includes("/") || id.includes("\\") || id === "..") {
    return err({ kind: "read-failed", detail: `unsafe extension id: ${id}` })
  }
  return ok(id)
}

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: string }).code === code

const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Real file source: each subdirectory of `root` is one extension id, unless `linkMap`
 * overrides that id to an absolute directory read live instead — the mechanism Plan 3's
 * `link` install mode depends on. No symlinks (they need elevation on Windows).
 */
export const createDirExtensionFileSource = (
  root: string,
  linkMap: Readonly<Record<string, string>>,
): ExtensionFileSource => {
  /** `linkMap[id]` when linked, else `root/id`. Ids are validated by every async caller first. */
  const resolveDir = (id: string): string => linkMap[id] ?? join(root, id)

  return {
    listExtensions: async (): Promise<
      Result<
        readonly (
          | ExtensionEntry
          | { readonly id: string; readonly error: PluginError }
        )[],
        PluginError
      >
    > => {
      let rootIds: readonly string[]
      try {
        const dirents = await readdir(root, { withFileTypes: true })
        rootIds = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
      } catch (cause) {
        // A missing plugin root is not an error — either the user has no COPY/GIT-installed
        // plugins yet, or (link mode) none was ever needed: a linked install writes nothing
        // under root, so the root can stay absent forever while `linkMap` alone carries every
        // installed extension. Fall through with an empty `rootIds` rather than returning here
        // — an early `ok([])` would silently drop every linked extension until some unrelated
        // git/copy install happened to create the root directory first.
        if (isErrno(cause, "ENOENT")) rootIds = []
        else return err({ kind: "read-failed", detail: detailOf(cause) })
      }

      // Union: a copy-installed extension is a directory under root; a link-installed one
      // is announced purely by its linkMap entry, regardless of whether root also holds it.
      const ids = new Set<string>([...rootIds, ...Object.keys(linkMap)])
      const out: (
        | ExtensionEntry
        | { readonly id: string; readonly error: PluginError }
      )[] = []

      for (const id of ids) {
        const safe = safeId(id)
        if (!safe.ok) return safe

        const isLinked = Object.hasOwn(linkMap, id)
        const dir = resolveDir(id)

        try {
          await stat(dir)
        } catch (cause) {
          if (isErrno(cause, "ENOENT")) {
            // A dead link fails only this one extension; everything else still loads.
            if (isLinked) {
              out.push({
                id,
                error: { kind: "source-unavailable", id, path: dir },
              })
            }
            // An unlinked entry vanishing between readdir and stat is skipped, same as
            // a directory with no manifest — nothing to report per-extension for it.
            continue
          }
          return err({
            kind: "read-failed",
            detail: `${id}: ${detailOf(cause)}`,
          })
        }

        let raw: unknown
        try {
          const text = await Bun.file(join(dir, MANIFEST_FILE)).text()
          raw = JSON.parse(text) as unknown
        } catch (cause) {
          // The plugin root may hold stray directories with no manifest — skip, not an error.
          if (isErrno(cause, "ENOENT")) continue
          return err({
            kind: "read-failed",
            detail: `${id}: ${detailOf(cause)}`,
          })
        }

        out.push({ id, raw })
      }

      return ok(out)
    },

    readExtension: async (
      id: string,
    ): Promise<Result<ExtensionEntry, PluginError>> => {
      const safe = safeId(id)
      if (!safe.ok) return safe

      const isLinked = Object.hasOwn(linkMap, id)
      const dir = resolveDir(id)

      try {
        await stat(dir)
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) {
          return err(
            isLinked
              ? { kind: "source-unavailable", id, path: dir }
              : { kind: "not-found", id },
          )
        }
        return err({ kind: "read-failed", detail: detailOf(cause) })
      }

      try {
        const text = await Bun.file(join(dir, MANIFEST_FILE)).text()
        return ok({ id, raw: JSON.parse(text) as unknown })
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) return err({ kind: "not-found", id })
        return err({ kind: "read-failed", detail: detailOf(cause) })
      }
    },

    removeExtension: async (id: string): Promise<Result<void, PluginError>> => {
      const safe = safeId(id)
      if (!safe.ok) return safe
      // Always the root-owned directory, never a linked path — deleting a caller's
      // external link source would be destructive and is out of scope here.
      try {
        await rm(join(root, id), { recursive: true, force: true })
        return ok(undefined)
      } catch (cause) {
        return err({ kind: "write-failed", detail: detailOf(cause) })
      }
    },

    // Guarded structurally by the `PluginId` brand (see file-source.ts) rather than by
    // `safeId` — `extensionDir` returns a bare `string` and has no `Result` to reject
    // through, so the type itself must be the thing that makes an unsafe id unreachable.
    extensionDir: (id: PluginId): string => resolveDir(id),
  }
}

/**
 * Real manifest reader: `Bun.file(<dir>/spectrum-extension.json).text()` + `JSON.parse`. The
 * installer's own IO seam — separate from `ExtensionFileSource.readExtension` because the
 * installer reads a manifest mid-install, before the directory is necessarily reachable
 * through the file source's id-keyed lookup (a freshly cloned/copied dir, or a not-yet-linked
 * path source being validated at its original location).
 */
export const createFsReadManifest = (): ((
  dir: string,
) => Promise<Result<unknown, PluginError>>) => {
  return async (dir: string) => {
    try {
      const text = await Bun.file(join(dir, MANIFEST_FILE)).text()
      return ok(JSON.parse(text) as unknown)
    } catch (cause) {
      return err({ kind: "read-failed", detail: detailOf(cause) })
    }
  }
}

/**
 * Real `CaptureStdout`: `Bun.spawn` with stdout piped and awaited as text. The only caller
 * (`GitClient.revParse`) needs the child's stdout, which `ProcessSpawner` deliberately does
 * not expose — this is that one seam, kept separate rather than widening the spawner.
 */
export const createBunCaptureStdout = (): CaptureStdout => {
  return async (command, args, cwd) => {
    try {
      const child = Bun.spawn([command, ...args], {
        cwd,
        // Same policy as `createBunProcessSpawner` (the spawner `clone`/`fetch`/`checkout` go
        // through): merge the ambient env, then let `gitEnv()`'s overrides win, so `git
        // rev-parse` gets PATH/HOME/etc. from the environment plus the same askpass/proxy/
        // prompt neutralisation as every other git invocation here.
        env: { ...process.env, ...gitEnv() },
        stdio: ["inherit", "pipe", "inherit"],
      })
      const [text, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ])
      if (exitCode !== 0) {
        return err({
          kind: "git-failed",
          detail: `${command} ${args.join(" ")} exited with code ${exitCode}`,
        })
      }
      return ok(text)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return err({ kind: "git-failed", detail })
    }
  }
}

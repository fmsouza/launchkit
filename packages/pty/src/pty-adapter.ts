import type { Result } from "@spectrum/utils"
import type { TerminalError } from "./errors"

export interface SpawnInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly cols: number
  readonly rows: number
}

export interface PtyHandle {
  onData(cb: (bytes: Uint8Array) => void): void
  onExit(cb: (exitCode: number) => void): void
  write(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtySpawner {
  spawn(input: SpawnInput): Result<PtyHandle, TerminalError>
}

// The real spawner is `createBunFfiPtySpawner` (bun-ffi-pty.ts) — a Bun-native
// PTY built on libc `openpty(3)` via `bun:ffi`. node-pty was removed: its native
// addon does not deliver PTY bytes under the Bun runtime.

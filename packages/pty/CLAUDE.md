# @spectrum/pty

Terminal/PTY lifecycle for the in-app terminal panel.

## Responsibility
Owns the `TerminalManager` (a registry of live PTYs keyed by `(sessionId, tabId)`), the pure `TerminalInbound`/`TerminalOutbound` wire protocol, and the `PtySpawner`/`PtyHandle` SPI. The bun-side `apps/desktop/src/gui/terminal-socket.ts` wires `TerminalManager` to a loopback WebSocket (twin of `@spectrum/agent-driver` + `runner-socket.ts`).

## Public API
- `createTerminalManager(deps)` → `TerminalManager` (`launch`, `handleInbound`, `bindSend`, `dispose`)
- `createNoopTerminalManager()` (fallback that emits a `term-error` "Terminal unavailable" when no native PTY)
- `decodeTerminalInbound` (zod-validated inbound frame decoder)
- `TerminalInbound`, `TerminalOutbound`, `TerminalError`, `TerminalSession` types
- `createBunFfiPtySpawner()`, `createFakePtySpawner()`
- `checkNativePtyAvailable()` (probes `bun:ffi` `openpty`; false on Windows)

## Local invariants
- Effects (spawn) only through the injected `PtySpawner`; the real spawner is `createBunFfiPtySpawner` (libc `openpty(3)` via `bun:ffi` — node-pty was removed because its native addon does not deliver PTY bytes under the Bun runtime). All `bun:ffi`/`node:*` access stays inside `bun-ffi-pty.ts`, loaded via lazy `require` so the webview bundle never follows it.
- `launch` returns `Result<TerminalSession, TerminalError>`; never throws.
- PTY bytes are NEVER logged (may contain secrets). Only lifecycle/boundary events are logged.
- `command` is always `process.env.SHELL` (default `/bin/zsh`); `args` is always `["-l"]` (fixed, arg-array discipline).

# apps/desktop (launchkit binary)

**Responsibility:** the dual-mode entry (`detectMode` -> CLI vs GUI) + the GUI shell (window, tray, IPC handlers) + React pages; the ONE place real effects are constructed and injected into the packages.

**Public surface (not a library -- the user-facing `launchkit` binary):** `src/main.ts` (entry: `runApp(detectMode(argv), argv, realDeps)`); `src/app.ts` (`runApp` mode router); `src/composition.ts` (`AppContext` + `createAppContext` real-adapter wiring); `src/gui/window.ts` (`openWindow` Electrobun seam); `src/gui/ipc/handlers.ts` (`createIpcHandlers` binding the ipc contract to subsystems). Owned by OTHER plans: `src/gui/tray.ts` (tray-and-polish), `views/**` (gui-pages), `src/detect-mode.ts` (phase0).

**Depends on:** every `@launchkit/*` package (`cli`, `proxy`, `harnesses`, `config`, `sessions`, `secrets`, `ipc`, `ui`, `types`, `utils`) -- see build-plan/02-monorepo/boundaries.md.

**Effects owned:** ALL of them -- but only via constructing the real adapters in `composition.ts` and injecting them. `createAppContext` is flat and logic-free; every decision lives in `runApp` / `createIpcHandlers` (separately unit-tested with fakes). Electrobun (window + message bus) lives behind thin injected seams in `gui/window.ts` so the logic is testable without a running window.

**Local rules:** this is the only place real fs/keychain/sqlite/process/server adapters are built. SECURITY: a `Provider` is ALWAYS projected to a `ProviderView` before crossing IPC (no secret value or `ref` to the webview); `setProviderSecret` is the only inbound secret path and writes straight to the keychain, persisting only the returned `SecretRef`; the proxy is started bound to loopback (`config.settings.proxyHost` = `127.0.0.1`) with a per-run key. Confirm Electrobun's `BrowserWindow`/IPC API against current docs and adapt only the `gui/window.ts` seam if it diverges.
- The system tray (`src/gui/tray.ts`) is built from the PURE `buildTrayMenu` descriptor (`src/gui/tray-menu.ts`); the native Electrobun Tray lives only behind the `MountTrayDeps.createTray` seam, and a Launch click reuses the same `ctx.launch` + `ctx.sessions.create` path as the IPC `launchHarness` handler.

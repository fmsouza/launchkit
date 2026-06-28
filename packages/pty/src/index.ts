export type {
  TabId,
  TerminalInbound,
  TerminalOutbound,
} from "./protocol"
export {
  TabIdSchema,
  TerminalInboundSchema,
  TerminalOutboundSchema,
  decodeTerminalInbound,
  isTerminalOutbound,
} from "./protocol"
export type { PtySpawner, PtyHandle, SpawnInput } from "./pty-adapter"
export { createBunFfiPtySpawner } from "./bun-ffi-pty"
export { createFakePtySpawner } from "./fake-pty"
export type { FakePtySpawner, FakePtyHandle } from "./fake-pty"
export type { TerminalError } from "./errors"
export type {
  TerminalManager,
  TerminalManagerDeps,
  TerminalSession,
} from "./manager"
export { createTerminalManager, createNoopTerminalManager } from "./manager"
export {
  checkNativePtyAvailable,
  nativePtyAvailable,
} from "./native-availability"

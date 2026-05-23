import type { HarnessDefinition } from "@launchkit/types"
import { claude } from "./claude"
import { codex } from "./codex"
import { openclaw } from "./openclaw"
import { opencode } from "./opencode"

export { claude } from "./claude"
export { codex } from "./codex"
export { opencode } from "./opencode"
export { openclaw } from "./openclaw"

export const builtinHarnesses: readonly HarnessDefinition[] = [
  claude,
  codex,
  opencode,
  openclaw,
]

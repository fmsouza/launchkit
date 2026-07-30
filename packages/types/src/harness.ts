import { z } from "zod"
import { ApiFormatSchema } from "./enums"
import { HarnessIdSchema } from "./ids"

export const HarnessAcpSchema = z
  .object({
    // Args to launch the harness in ACP mode, appended to the resolved command.
    args: z.array(z.string().min(1)).min(1),
    // true if the harness exposes ACP natively; false if via a Zed adapter shim.
    native: z.boolean(),
  })
  .strict()
export type HarnessAcp = z.infer<typeof HarnessAcpSchema>

export const HarnessDefinitionSchema = z
  .object({
    id: HarnessIdSchema,
    name: z.string().min(1),
    command: z.string().min(1),
    apiFormat: ApiFormatSchema,
    envTemplate: z.record(z.string(), z.string()),
    // Optional CLI args (proxied mode only), rendered with the same {{proxyUrl}}/{{proxyKey}}/{{model}}
    // tokens as envTemplate. Used by harnesses that need flags to route through the proxy (e.g. codex
    // requires `-c` provider config; env vars alone don't redirect it).
    argsTemplate: z.array(z.string()).optional(),
    // Optional ACP (Agent Client Protocol) launch config. When present, `resolveHarnessLaunch`
    // can be called with `mode: "acp"` to produce the harness binary + these args + the rendered
    // proxy env (the ACP agent still reaches the LLM through the Spectrum proxy via env vars).
    acp: HarnessAcpSchema.optional(),
    description: z.string().optional(),
    builtIn: z.boolean(),
  })
  .strict()

export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>

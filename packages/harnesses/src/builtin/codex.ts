import {
  AliasNameSchema,
  type HarnessDefinition,
  HarnessIdSchema,
} from "@launchkit/types"

export const codex: HarnessDefinition = {
  id: HarnessIdSchema.parse("codex"),
  name: "Codex",
  command: "codex",
  apiFormat: "openai",
  envTemplate: {
    OPENAI_BASE_URL: "{{proxyUrl}}",
    OPENAI_API_KEY: "{{proxyKey}}",
    OPENAI_MODEL: "{{model}}",
  },
  defaultAlias: AliasNameSchema.parse("default"),
  builtIn: true,
} satisfies HarnessDefinition

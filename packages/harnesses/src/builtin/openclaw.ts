import {
  AliasNameSchema,
  type HarnessDefinition,
  HarnessIdSchema,
} from "@launchkit/types"

export const openclaw: HarnessDefinition = {
  id: HarnessIdSchema.parse("openclaw"),
  name: "openclaw",
  command: "openclaw",
  apiFormat: "anthropic",
  envTemplate: {
    ANTHROPIC_BASE_URL: "{{proxyUrl}}",
    ANTHROPIC_API_KEY: "{{proxyKey}}",
    ANTHROPIC_MODEL: "{{model}}",
  },
  defaultAlias: AliasNameSchema.parse("default"),
  builtIn: true,
} satisfies HarnessDefinition

import { type HarnessDefinition, HarnessIdSchema } from "@spectrum/types"

/**
 * Gemini CLI speaks ACP natively (`gemini --acp`; `--experimental-acp` is its deprecated alias).
 *
 * This entry exists to demonstrate the point of the ACP migration: adding an agent is a HARNESS
 * DEFINITION, not a driver package. Nothing else in the codebase knows about Gemini — the ACP
 * driver is selected automatically for any harness that declares an `acp` config.
 *
 * Gemini authenticates with its own credentials (`GEMINI_API_KEY` / Google login) and is not
 * routed through the Spectrum proxy, so no env is rendered. Install with
 * `npm i -g @google/gemini-cli`.
 */
export const gemini: HarnessDefinition = {
  id: HarnessIdSchema.parse("gemini"),
  name: "Gemini CLI",
  command: "gemini",
  apiFormat: "openai",
  description:
    "Gemini CLI over ACP. Uses its own Google credentials — not routed through the Spectrum proxy.",
  envTemplate: {},
  builtIn: true,
  acp: { args: ["--acp"], native: true },
} satisfies HarnessDefinition

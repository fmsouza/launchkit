import { type Result, err, ok } from "@spectrum/utils"
import type { PluginError } from "./errors"
import type {
  PluginLaunch,
  ProviderContribution,
} from "./provider-contribution"

/**
 * Tokens every plugin launch template may use regardless of what it declares — the
 * runtime facts about the spawned server (its port/host/baseUrl) plus the per-run
 * `hostToken` Spectrum mints to authenticate the plugin process back to the host.
 */
export const RUNTIME_TOKENS = ["port", "host", "baseUrl", "hostToken"] as const

const TOKEN = /\{\{(\w+)\}\}/g

const tokensIn = (value: string): readonly string[] =>
  [...value.matchAll(TOKEN)].map((m) => m[1] ?? "")

/**
 * The allowed-token set is computed per contribution — unlike harnesses' fixed list —
 * because a plugin's own declared secret and config field names are template-addressable
 * (e.g. `{{apiKey}}`, `{{serverUrl}}`), on top of the fixed runtime tokens.
 */
export const allowedTokensFor = (
  contribution: ProviderContribution,
): ReadonlySet<string> => {
  const tokens = new Set<string>(RUNTIME_TOKENS)
  for (const field of contribution.descriptor.secretFields)
    tokens.add(field.name)
  for (const field of contribution.descriptor.configFields)
    tokens.add(field.name)
  return tokens
}

/** Rejects any `{{token}}` in the launch's env or args that the contribution never declared. */
export const validateContributionTemplates = (
  contribution: ProviderContribution,
): Result<void, PluginError> => {
  const launch = contribution.transport.launch
  if (launch === undefined) return ok(undefined)
  const allowed = allowedTokensFor(contribution)
  const values = [...Object.values(launch.envTemplate), ...launch.args]
  for (const value of values) {
    for (const token of tokensIn(value)) {
      if (!allowed.has(token)) {
        return err({
          kind: "invalid-manifest",
          detail: `unknown template token "${token}"`,
        })
      }
    }
  }
  return ok(undefined)
}

const render = (
  template: string,
  values: Readonly<Record<string, string>>,
): string =>
  template.replace(TOKEN, (_match, token: string) => values[token] ?? "")

/** Renders a launch's env template. A token with no supplied value renders to `""`. */
export const renderPluginEnv = (
  launch: PluginLaunch,
  values: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, template] of Object.entries(launch.envTemplate)) {
    out[key] = render(template, values)
  }
  return out
}

/** Renders a launch's args template. A token with no supplied value renders to `""`. */
export const renderPluginArgs = (
  launch: PluginLaunch,
  values: Readonly<Record<string, string>>,
): string[] => launch.args.map((arg) => render(arg, values))

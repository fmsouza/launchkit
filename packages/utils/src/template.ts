import { type Result, ok, err } from "./result"

export type TemplateError = { readonly kind: "unknown-token"; readonly token: string }

const TOKEN = /\{\{(\w+)\}\}/g

export const renderTemplate = (
  template: string,
  vars: Readonly<Record<string, string>>,
): Result<string, TemplateError> => {
  let unknown: string | undefined
  const out = template.replace(TOKEN, (_match, token: string) => {
    const value = vars[token]
    if (value === undefined) { unknown ??= token; return _match }
    return value
  })
  return unknown === undefined ? ok(out) : err({ kind: "unknown-token", token: unknown })
}

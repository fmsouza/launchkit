/** The extension API major this Spectrum implements. A manifest declaring a newer major is refused. */
export const SUPPORTED_API_MAJOR = 1
const API_GROUP = "spectrum.dev"

/** Pure: split `spectrum.dev/v1` into its group and major. Undefined when malformed. */
export const parseApiVersion = (
  v: string,
): { readonly group: string; readonly major: number } | undefined => {
  const match = /^([a-z0-9.-]+)\/v(\d+)$/.exec(v)
  if (match === null) return undefined
  return { group: match[1] ?? "", major: Number(match[2]) }
}

export const isSupportedApiVersion = (v: string): boolean => {
  const parsed = parseApiVersion(v)
  return (
    parsed !== undefined &&
    parsed.group === API_GROUP &&
    parsed.major <= SUPPORTED_API_MAJOR
  )
}

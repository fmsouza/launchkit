export type TokenGen = () => string

export const HOST_TOKEN_HEADER = "x-spectrum-host-token"

export const createCryptoTokenGen = (): TokenGen => (): string =>
  crypto.randomUUID()

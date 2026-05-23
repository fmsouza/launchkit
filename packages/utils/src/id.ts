export interface IdGen {
  next(prefix: string): string
}

export const createCryptoIdGen = (): IdGen => ({
  next: (prefix) => `${prefix}_${crypto.randomUUID()}`,
})

export const createSequentialIdGen = (): IdGen => {
  let n = 0
  return { next: (prefix) => `${prefix}_${++n}` }
}

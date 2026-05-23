export interface Clock {
  now(): Date
}

export const createSystemClock = (): Clock => ({ now: () => new Date() })

export const createFixedClock = (instant: Date): Clock => ({
  now: () => new Date(instant),
})

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Frozen clock for tests, so weekday- and deadline-dependent logic is stable. */
export function fakeClock(iso: string): Clock {
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) throw new Error(`Invalid clock time: ${iso}`);
  return { now: () => new Date(fixed) };
}

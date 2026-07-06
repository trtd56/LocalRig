/** Apply a rate (0.08 = 8%) on top of a base amount: base * (1 + rate). */
export function applyRate(base: number, rate: number): number {
  return base * (1 + rate);
}

/** The portion of `base` represented by `rate` (0.08 = 8%). */
export function portionOf(base: number, rate: number): number {
  return base * rate;
}

/** Round a percentage to one decimal place, for display. */
export function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

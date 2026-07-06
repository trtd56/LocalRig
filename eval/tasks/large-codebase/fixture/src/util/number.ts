/** General-purpose rounding to an arbitrary number of decimal places. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Clamp n into the inclusive range [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Sum a list of numbers. */
export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Arithmetic mean, or 0 for an empty list. */
export function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

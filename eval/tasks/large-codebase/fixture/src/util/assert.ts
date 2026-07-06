/** Throw if a value is not strictly greater than zero. */
export function assertPositive(value: number, label: string): void {
  if (!(value > 0)) throw new Error(`${label} must be positive, got ${value}`);
}

/** Throw if a value is negative. */
export function assertNonNegative(value: number, label: string): void {
  if (value < 0) throw new Error(`${label} must not be negative, got ${value}`);
}

/** Throw if a list is empty. */
export function assertNonEmpty<T>(items: T[], label: string): void {
  if (items.length === 0) throw new Error(`${label} must not be empty`);
}

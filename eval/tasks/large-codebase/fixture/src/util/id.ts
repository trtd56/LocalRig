let counter = 0;

/** Process-scoped monotonic id, e.g. nextId("ord") -> "ord-00001". */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(5, "0")}`;
}

/** Reset the counter. Intended for deterministic tests. */
export function resetIds(): void {
  counter = 0;
}

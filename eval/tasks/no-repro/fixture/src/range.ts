// Numeric range parsing used by the pagination layer.

/**
 * Parses a numeric range specification into the explicit list of integers it
 * denotes.
 *
 * Grammar (whitespace around any token is tolerated):
 *   spec := part ("," part)*
 *   part := number | number "-" number
 *
 * Semantics:
 *   - A bare number N yields [N]                      e.g. "3"     -> [3]
 *   - "A-B" yields the INCLUSIVE run from A to B:
 *       ascending  when A <= B                        e.g. "1-4"   -> [1, 2, 3, 4]
 *       descending when A >  B                        e.g. "5-3"   -> [5, 4, 3]
 *   - Comma-separated parts are concatenated left to right, so
 *     "1,3,5-7" -> [1, 3, 5, 6, 7]. Duplicates are kept, not deduplicated.
 *
 * Only non-negative integers are valid endpoints. Any other input — an empty
 * string, an empty segment (e.g. "1,,2"), a non-integer token, or a malformed
 * range such as "1-2-3" — throws an Error.
 */
export function parseRange(s: string): number[] {
  const out: number[] = [];
  for (const rawPart of s.split(",")) {
    const part = rawPart.trim();
    if (part === "") {
      throw new Error(`invalid range spec: empty segment in "${s}"`);
    }
    const bounds = part.split("-").map((t) => t.trim());
    if (bounds.length === 1) {
      out.push(toInt(bounds[0]!, s));
    } else if (bounds.length === 2) {
      const from = toInt(bounds[0]!, s);
      const to = toInt(bounds[1]!, s);
      const step = from <= to ? 1 : -1;
      for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(n);
    } else {
      throw new Error(`invalid range spec: malformed range "${part}" in "${s}"`);
    }
  }
  return out;
}

function toInt(token: string, spec: string): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(`invalid range spec: "${token}" is not a non-negative integer (in "${spec}")`);
  }
  return Number(token);
}

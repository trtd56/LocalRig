/** @deprecated Use formatDate / formatNum from ./format instead (options-object API). */

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Legacy date formatter: token replacement over YYYY / MM / DD / HH / mm. */
export function fmtDate(d: Date, pattern: string): string {
  return pattern
    .replace("YYYY", String(d.getFullYear()))
    .replace("MM", pad2(d.getMonth() + 1))
    .replace("DD", pad2(d.getDate()))
    .replace("HH", pad2(d.getHours()))
    .replace("mm", pad2(d.getMinutes()));
}

/** Legacy number formatter: fixed number of decimal places. */
export function fmtNum(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

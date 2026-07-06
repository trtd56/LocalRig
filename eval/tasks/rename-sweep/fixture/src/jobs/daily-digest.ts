import { fmtDate } from "../lib/fmt";

export function digestHeader(day: Date): string {
  return `Daily digest — ${fmtDate(day, "YYYY-MM-DD")} (${fmtDate(day, "HH:mm")})`;
}

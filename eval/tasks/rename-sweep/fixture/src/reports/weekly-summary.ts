import { fmtDate, fmtNum } from "../lib/fmt";

export function weeklySummary(weekStart: Date, revenue: number): string {
  return `Week of ${fmtDate(weekStart, "YYYY-MM-DD")}: $${fmtNum(revenue, 2)}`;
}

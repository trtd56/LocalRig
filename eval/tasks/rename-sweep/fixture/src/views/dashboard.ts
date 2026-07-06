import { fmtDate, fmtNum } from "../lib/fmt";

export function dashboardTile(label: string, value: number, updatedAt: Date): string {
  return `${label}: ${fmtNum(value, 0)} (updated ${fmtDate(updatedAt, "HH:mm")})`;
}

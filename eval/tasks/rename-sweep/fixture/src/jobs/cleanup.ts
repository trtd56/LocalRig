import { fmtDate, fmtNum } from "../lib/fmt";

export function cleanupLog(ranAt: Date, freedMb: number): string {
  return `cleanup @ ${fmtDate(ranAt, "HH:mm")} freed ${fmtNum(freedMb, 1)} MB`;
}

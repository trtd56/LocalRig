import { fmtNum } from "../lib/fmt";

export function metricsRow(name: string, p50: number, p99: number): string {
  return `${name}\t${fmtNum(p50, 3)}\t${fmtNum(p99, 3)}`;
}

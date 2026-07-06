import { log } from "../lib/log";

// module-source: analytics.churn
export function churnAlert(pct: number): string {
  return log.write("warn", `churn pct=${pct}`);
}

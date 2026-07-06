import { log } from "../lib/log";

// module-source: analytics.cohort
export function cohortRow(week: number, kept: number): string {
  return log.write("info", `cohort w${week} kept=${kept}`);
}

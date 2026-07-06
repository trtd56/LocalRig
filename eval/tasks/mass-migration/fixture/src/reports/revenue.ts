import { log } from "../lib/log";

// module-source: analytics.revenue
export function revenueLine(gross: number): string {
  return log.write("info", `revenue gross=${gross}`);
}
export function revenueSummary(net: number): string {
  return log.write("info", `revenue net=${net}`);
}

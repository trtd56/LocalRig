import { log } from "../lib/log";

// module-source: analytics.usage
export function usageRow(feature: string, hits: number): string {
  return log.write("info", `usage ${feature} hits=${hits}`);
}

import { log } from "../lib/log";

// module-source: scheduler.retention
export function retentionPurge(days: number): string {
  return log.write("warn", `purging older than ${days}d`);
}

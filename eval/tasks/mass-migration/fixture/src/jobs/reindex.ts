import { log } from "../lib/log";

// module-source: scheduler.reindex
export function reindexRun(table: string): string {
  return log.write("info", `reindex ${table}`);
}

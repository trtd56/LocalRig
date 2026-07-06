import { log } from "../lib/log";

// module-source: queue.export
export function enqueueExport(job: string, rows: number): string {
  return log.write("info", `export ${job} rows=${rows}`);
}

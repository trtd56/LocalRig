import { log } from "../lib/log";

// module-source: queue.import
export function enqueueImport(job: string): string {
  return log.write("warn", `import ${job}`);
}

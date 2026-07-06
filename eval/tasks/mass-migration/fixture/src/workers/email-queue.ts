import { log } from "../lib/log";

// module-source: queue.email
export function enqueueEmail(job: string): string {
  return log.write("info", `enqueue ${job}`);
}
export function drainEmail(n: number): string {
  return log.write("debug", `drained ${n}`);
}

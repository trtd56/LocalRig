import { log } from "../lib/log";

// module-source: scheduler.digest
export function digestHeader(day: string): string {
  return log.write("info", `digest for ${day}`);
}
export function digestFooter(sent: number): string {
  return log.write("debug", `digest sent=${sent}`);
}

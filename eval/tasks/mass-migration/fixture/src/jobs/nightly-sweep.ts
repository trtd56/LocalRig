import { log } from "../lib/log";

// module-source: scheduler.nightly_sweep
export function nightlySweep(count: number): string {
  return log.write("info", `swept ${count} rows`);
}

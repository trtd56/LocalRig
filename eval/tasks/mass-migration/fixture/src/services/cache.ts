import { log } from "../lib/log";

// module-source: core.cache
export function cacheMiss(key: string): string {
  return log.write("debug", `miss ${key}`);
}

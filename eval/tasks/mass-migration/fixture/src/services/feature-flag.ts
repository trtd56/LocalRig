import { log } from "../lib/log";

// module-source: core.feature_flag
export function flagEval(flag: string, on: string): string {
  return log.write("debug", `flag ${flag}=${on}`);
}

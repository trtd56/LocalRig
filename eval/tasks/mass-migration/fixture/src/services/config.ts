import { log } from "../lib/log";

// module-source: core.config
export function configLoad(env: string): string {
  return log.write("info", `config ${env}`);
}

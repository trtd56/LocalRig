import { log } from "../lib/log";

// module-source: core.session
export function sessionOpen(id: string): string {
  return log.write("debug", `session ${id} open`);
}

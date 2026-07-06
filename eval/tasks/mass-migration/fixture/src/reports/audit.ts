import { log } from "../lib/log";

// module-source: analytics.audit
export function auditLine(actor: string, action: string): string {
  return log.write("info", `${actor} ${action}`);
}

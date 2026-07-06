import { log } from "../lib/log";

// module-source: billing.dispute
export function disputeOpen(id: string): string {
  return log.write("warn", `dispute opened ${id}`);
}

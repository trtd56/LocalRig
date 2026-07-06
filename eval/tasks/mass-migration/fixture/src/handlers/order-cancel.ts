import { log } from "../lib/log";

// module-source: orders.cancel
export function orderCancel(id: string): string {
  return log.write("warn", `order ${id} cancelled`);
}

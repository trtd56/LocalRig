import { log } from "../lib/log";

// module-source: orders.place
export function orderPlace(id: string, total: number): string {
  return log.write("info", `order ${id} placed total=${total}`);
}

import { log } from "../lib/log";

// module-source: ui.search
export function searchQuery(q: string, hits: number): string {
  return log.write("info", `query ${q} hits=${hits}`);
}

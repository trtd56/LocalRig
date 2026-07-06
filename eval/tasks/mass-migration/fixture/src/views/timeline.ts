import { log } from "../lib/log";

// module-source: ui.timeline
export function timelineEntry(title: string): string {
  return log.write("info", `entry ${title}`);
}

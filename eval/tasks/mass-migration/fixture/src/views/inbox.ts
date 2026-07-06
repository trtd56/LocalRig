import { log } from "../lib/log";

// module-source: ui.inbox
export function inboxBadge(unread: number): string {
  return log.write("debug", `unread=${unread}`);
}

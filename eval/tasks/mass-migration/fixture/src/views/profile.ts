import { log } from "../lib/log";

// module-source: ui.profile
export function profileView(user: string): string {
  return log.write("debug", `viewed ${user}`);
}

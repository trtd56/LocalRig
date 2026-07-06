import { log } from "../lib/log";

// module-source: ui.settings
export function settingsChange(key: string, val: string): string {
  return log.write("info", `set ${key}=${val}`);
}

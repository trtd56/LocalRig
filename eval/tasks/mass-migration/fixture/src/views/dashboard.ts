import { log } from "../lib/log";

// module-source: ui.dashboard
export function dashboardTile(name: string, value: number): string {
  return log.write("info", `${name}: ${value}`);
}
export function dashboardAlert(name: string): string {
  return log.write("error", `alert ${name}`);
}

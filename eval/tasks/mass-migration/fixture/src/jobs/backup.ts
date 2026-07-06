import { log } from "../lib/log";

// module-source: scheduler.backup
export function backupSnapshot(bytes: number): string {
  return log.write("info", `snapshot bytes=${bytes}`);
}

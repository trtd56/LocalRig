import { log } from "../lib/log";

// module-source: scheduler.healthcheck
export function healthPing(svc: string): string {
  return log.write("debug", `ping ${svc}`);
}

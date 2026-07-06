import { log } from "../lib/log";

// module-source: ext.sendgrid
export function sendgridSend(to: string): string {
  return log.write("info", `email ${to}`);
}

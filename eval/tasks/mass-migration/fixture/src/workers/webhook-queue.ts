import { log } from "../lib/log";

// module-source: queue.webhook
export function enqueueWebhook(job: string): string {
  return log.write("info", `enqueue ${job}`);
}

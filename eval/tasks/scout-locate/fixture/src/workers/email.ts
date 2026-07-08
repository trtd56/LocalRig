import { withRetryPolicy } from "../core/retry-policy";

export function sendEmail(job: () => Promise<void>): Promise<void> {
  return withRetryPolicy(job, { attempts: 3, backoffMs: 50 });
}

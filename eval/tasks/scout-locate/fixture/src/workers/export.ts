import { withRetryPolicy } from "../core/retry-policy";

export function runExport(job: () => Promise<string>): Promise<string> {
  return withRetryPolicy(job, { attempts: 2, backoffMs: 10 });
}

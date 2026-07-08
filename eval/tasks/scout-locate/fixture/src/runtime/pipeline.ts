import { withRetryPolicy } from "../core/retry-policy";

export const runtimePipeline = {
  retry: withRetryPolicy,
  defaults: { attempts: 3, backoffMs: 25 },
};

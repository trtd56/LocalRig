import { runtimePipeline } from "../runtime/pipeline";

export function deliverWebhook(job: () => Promise<Response>): Promise<Response> {
  return runtimePipeline.retry(job, runtimePipeline.defaults);
}

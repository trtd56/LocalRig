import { MAX_RETRIES } from "../config/constants";
import { dequeue, type Job } from "./scheduler";
import { info, warn } from "../log/logger";

export async function runNext(execute: (job: Job) => Promise<void>): Promise<boolean> {
  const job = dequeue();
  if (!job) return false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await execute(job);
      info(`job #${job.id} done (attempt ${attempt})`);
      return true;
    } catch (err) {
      warn(`job #${job.id} attempt ${attempt} failed: ${err}`);
    }
  }
  return true;
}

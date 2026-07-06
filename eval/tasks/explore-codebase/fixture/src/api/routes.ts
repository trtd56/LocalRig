import { enqueue } from "../core/scheduler";
import { padId } from "../utils/strings";

export function handleEnqueue(command: string, priority: string): string {
  const job = enqueue(command, priority);
  return `created job ${padId(job.id)}`;
}

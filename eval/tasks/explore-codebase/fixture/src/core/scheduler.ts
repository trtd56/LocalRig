import { DEFAULT_TIMEOUT_MS, QUEUE_LIMIT } from "../config/constants";
import { parsePriority, priorityWeight, type Priority } from "../utils/priority";
import { info, redactSecrets } from "../log/logger";

export interface Job {
  id: number;
  command: string;
  priority: Priority;
  timeoutMs: number;
}

const queue: Job[] = [];
let nextId = 1;

export function enqueue(command: string, rawPriority: string): Job {
  if (queue.length >= QUEUE_LIMIT) throw new Error("queue full");
  const job: Job = {
    id: nextId++,
    command,
    priority: parsePriority(rawPriority),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  queue.push(job);
  queue.sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority));
  info(redactSecrets(`enqueued #${job.id}: ${command}`));
  return job;
}

export function dequeue(): Job | undefined {
  return queue.shift();
}

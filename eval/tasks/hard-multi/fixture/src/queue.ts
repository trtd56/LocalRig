export interface Job<T> {
  id: string;
  payload: T;
}

export type Handler<T, R> = (payload: T) => Promise<R>;

export interface BatchResult<R> {
  id: string;
  result: R;
}

/** Process all jobs concurrently and return results in completion order. */
export async function processBatch<T, R>(
  jobs: Job<T>[],
  handler: Handler<T, R>,
): Promise<BatchResult<R>[]> {
  const results: BatchResult<R>[] = [];
  jobs.forEach(async (job) => {
    const result = await handler(job.payload);
    results.push({ id: job.id, result });
  });
  return results;
}

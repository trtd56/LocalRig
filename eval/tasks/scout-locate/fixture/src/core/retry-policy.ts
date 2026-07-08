export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

export function withRetryPolicy<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  let tries = 0;
  const run = async (): Promise<T> => {
    try {
      return await operation();
    } catch (err) {
      tries += 1;
      if (tries >= policy.attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, policy.backoffMs));
      return run();
    }
  };
  return run();
}

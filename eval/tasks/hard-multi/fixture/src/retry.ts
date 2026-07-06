export interface RetryOptions {
  maxAttempts: number;
  delayMs?: number;
}

/** Run fn, retrying on failure up to maxAttempts total attempts. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (options.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
    }
  }
  throw lastError;
}

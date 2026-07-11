export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  take(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  private refill(): void {
    const current = this.now();
    const elapsedSeconds = Math.max(0, current - this.lastRefillMs) / 1000;
    const added = Math.floor(elapsedSeconds * this.refillPerSecond);
    if (added <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    // BUG: discards the fractional interval and makes repeated polls count it again.
    this.lastRefillMs = current - (elapsedSeconds * 1000 - added / this.refillPerSecond);
  }
}

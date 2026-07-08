/** A command-scoped wall-clock deadline shared by model, tool, and check I/O. */
export class RunDeadline {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private _cause: "timeout" | "interrupted" | undefined;
  deadlineAt: number | undefined;
  private readonly parentSignal?: AbortSignal;

  constructor(
    timeoutMs: number,
    private readonly now: () => number = Date.now,
    parentSignal?: AbortSignal,
    startedAt: number = now(),
  ) {
    this.parentSignal = parentSignal;
    this.deadlineAt = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? startedAt + Math.max(1, Math.floor(timeoutMs))
      : undefined;

    if (parentSignal) {
      if (parentSignal.aborted) this.interrupt(parentSignal.reason);
      else parentSignal.addEventListener("abort", this.onParentAbort, { once: true });
    }
    if (this.deadlineAt !== undefined && !this.signal.aborted) {
      this.armTimer();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cause(): "timeout" | "interrupted" | undefined {
    // Fake/injected clocks may advance without allowing a timer tick. Reading
    // the cause makes the deadline deterministic for both production and tests.
    if (!this._cause && this.deadlineAt !== undefined && this.now() >= this.deadlineAt) {
      this.expire();
    }
    return this._cause;
  }

  get timedOut(): boolean {
    return this.cause === "timeout";
  }

  get interrupted(): boolean {
    return this.cause === "interrupted";
  }

  /** Milliseconds left, or Infinity when the command has no wall-clock cap. */
  remainingMs(): number {
    if (this.signal.aborted) return 0;
    if (this.deadlineAt === undefined) return Number.POSITIVE_INFINITY;
    const left = Math.max(0, this.deadlineAt - this.now());
    if (left === 0) this.expire();
    return left;
  }

  /** Clamp a local timeout to the command's remaining wall-clock budget. */
  clampTimeout(requestedMs: number): number {
    const requested = Number.isFinite(requestedMs) && requestedMs > 0
      ? Math.max(1, Math.floor(requestedMs))
      : 0;
    const remaining = this.remainingMs();
    if (remaining === Number.POSITIVE_INFINITY) return requested;
    return Math.max(0, Math.min(requested, Math.ceil(remaining)));
  }

  interrupt(reason: unknown = new DOMException("Interrupted", "AbortError")): void {
    if (this.controller.signal.aborted) return;
    this._cause = "interrupted";
    this.clearTimer();
    this.controller.abort(reason);
  }

  expire(): void {
    if (this.controller.signal.aborted) return;
    this._cause = "timeout";
    this.clearTimer();
    this.controller.abort(new DOMException("Command deadline exceeded", "TimeoutError"));
  }

  dispose(): void {
    this.clearTimer();
    // Disposal ends the wall-clock deadline, including the lazy expiry in the
    // cause/remainingMs getters. The controller intentionally stays live so a
    // command-level SIGINT handler can still call interrupt() while bounded
    // finalization/rollback runs under its own deadline.
    this.deadlineAt = undefined;
    this.parentSignal?.removeEventListener("abort", this.onParentAbort);
  }

  /** Configure a previously unlimited deadline once late-bound work size is known. */
  configure(timeoutMs: number, startedAt: number = this.now()): void {
    if (this.signal.aborted) return;
    this.clearTimer();
    this.deadlineAt = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? startedAt + Math.max(1, Math.floor(timeoutMs))
      : undefined;
    if (this.deadlineAt === undefined) return;
    if (this.now() >= this.deadlineAt) this.expire();
    else this.armTimer();
  }

  private readonly onParentAbort = (): void => {
    this.interrupt();
  };

  private armTimer(): void {
    const delay = Math.max(1, this.deadlineAt! - this.now());
    // setTimeout is limited to a signed 32-bit delay. Re-arm for very long
    // budgets instead of accidentally firing after 1 ms.
    const slice = Math.min(delay, 2_147_483_647);
    this.timer = setTimeout(() => {
      if (this.deadlineAt !== undefined && this.now() < this.deadlineAt) this.armTimer();
      else this.expire();
    }, slice);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Combine cancellation sources while retaining a cleanup hook for listeners. */
export function combineAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const live = signals.filter((signal, index) => signals.indexOf(signal) === index);
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of live) {
    const forward = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    listeners.set(signal, forward);
    if (signal.aborted) {
      forward();
      break;
    }
    signal.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

/** Clamp a timeout from ToolContext's absolute command deadline. */
export function clampToDeadline(requestedMs: number, deadlineAt?: number, now = Date.now()): number {
  const requested = Number.isFinite(requestedMs) && requestedMs > 0
    ? Math.max(1, Math.floor(requestedMs))
    : 0;
  if (deadlineAt === undefined) return requested;
  return Math.max(0, Math.min(requested, Math.ceil(deadlineAt - now)));
}

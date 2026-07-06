/**
 * A promise whose settlement is controlled manually from the outside.
 * Used by the tests in this directory to pin down exact interleavings of
 * concurrent AsyncCache calls without relying on setTimeout/sleep, which
 * would make the tests flaky.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

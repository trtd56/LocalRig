// why: gives every thrown error a machine-readable code so callers can branch
// on failures without string-matching messages.
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

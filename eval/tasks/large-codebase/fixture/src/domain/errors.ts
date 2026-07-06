/** Base class for all domain-level errors. */
export class DomainError extends Error {}

export class OutOfStockError extends DomainError {
  constructor(public readonly sku: string) {
    super(`out of stock: ${sku}`);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`invalid status transition: ${from} -> ${to}`);
  }
}

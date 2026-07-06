import type { Customer } from "../domain/types";

/** In-memory store of customers keyed by id. */
export class CustomerRepository {
  private items = new Map<string, Customer>();

  save(customer: Customer): void {
    this.items.set(customer.id, customer);
  }

  find(id: string): Customer | undefined {
    return this.items.get(id);
  }

  all(): Customer[] {
    return [...this.items.values()];
  }
}

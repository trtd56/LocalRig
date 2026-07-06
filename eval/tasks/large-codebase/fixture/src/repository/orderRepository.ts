import type { Order } from "../domain/types";

/** In-memory store of orders keyed by id. */
export class OrderRepository {
  private items = new Map<string, Order>();

  save(order: Order): void {
    this.items.set(order.id, order);
  }

  find(id: string): Order | undefined {
    return this.items.get(id);
  }

  all(): Order[] {
    return [...this.items.values()];
  }

  byCustomer(customerId: string): Order[] {
    return this.all().filter((o) => o.customerId === customerId);
  }
}

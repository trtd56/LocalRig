import { OrderRepository } from "../repository/orderRepository";
import { CustomerRepository } from "../repository/customerRepository";
import { PricingService } from "./pricingService";
import { nextId } from "../util/id";
import type { Order, OrderLine } from "../domain/types";

/** Orchestrates order creation and pricing. */
export class OrderService {
  constructor(
    private orders: OrderRepository,
    private customers: CustomerRepository,
    private pricing: PricingService,
  ) {}

  /** Create, price, and persist an order in the "placed" state. */
  checkout(customerId: string, lines: OrderLine[]): Order {
    const customer = this.customers.find(customerId);
    if (!customer) throw new Error(`unknown customer: ${customerId}`);
    const total = this.pricing.priceOrder(lines, customer.taxRegion);
    const order: Order = {
      id: nextId("ord"),
      customerId,
      lines,
      status: "placed",
      total,
    };
    this.orders.save(order);
    return order;
  }
}

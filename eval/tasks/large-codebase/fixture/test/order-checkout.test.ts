import { describe, expect, test } from "bun:test";
import { createApp } from "../src/index";

// End-to-end: customer -> pricing -> tax -> order total. The totals below are
// the correctly-rounded, tax-inclusive amounts a customer should be charged.
describe("order checkout (integration)", () => {
  test("total includes tax, correctly rounded (US_CA)", () => {
    const app = createApp();
    const customer = app.customers.register("Acme", "US_CA");
    const order = app.orders.checkout(customer.id, [
      { sku: "widget", unitPrice: 19.99, quantity: 1 },
    ]);
    expect(order.status).toBe("placed");
    expect(order.total).toBe(21.44);
  });

  test("total rounds up across multiple units (US_NY)", () => {
    const app = createApp();
    const customer = app.customers.register("Beta", "US_NY");
    const order = app.orders.checkout(customer.id, [
      { sku: "bolt", unitPrice: 4.15, quantity: 3 },
    ]);
    expect(order.total).toBe(13.45);
  });
});

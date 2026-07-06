import { describe, expect, test } from "bun:test";
import { CustomerService } from "../src/services/customerService";
import { CustomerRepository } from "../src/repository/customerRepository";

describe("customers", () => {
  test("register then look up", () => {
    const svc = new CustomerService(new CustomerRepository());
    const customer = svc.register("Acme", "US_CA");
    expect(customer.taxRegion).toBe("US_CA");
    expect(customer.id.startsWith("cust-")).toBe(true);
    expect(svc.get(customer.id)?.name).toBe("Acme");
  });
});

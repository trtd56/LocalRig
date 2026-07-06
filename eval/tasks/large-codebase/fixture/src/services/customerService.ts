import { CustomerRepository } from "../repository/customerRepository";
import { nextId } from "../util/id";
import type { Customer } from "../domain/types";

/** Manages customer records. */
export class CustomerService {
  constructor(private customers: CustomerRepository) {}

  register(name: string, taxRegion: string): Customer {
    const customer: Customer = { id: nextId("cust"), name, taxRegion };
    this.customers.save(customer);
    return customer;
  }

  get(id: string): Customer | undefined {
    return this.customers.find(id);
  }
}

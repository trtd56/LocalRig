import {
  ProductRepository,
  OrderRepository,
  InventoryRepository,
  CustomerRepository,
} from "./repository";
import {
  CatalogService,
  InventoryService,
  OrderService,
  PricingService,
  ReportService,
  CustomerService,
} from "./services";

/** Compose the full application graph. Useful for manual experiments. */
export function createApp() {
  const products = new ProductRepository();
  const orders = new OrderRepository();
  const inventory = new InventoryRepository();
  const customers = new CustomerRepository();

  return {
    catalog: new CatalogService(products),
    inventory: new InventoryService(inventory),
    customers: new CustomerService(customers),
    orders: new OrderService(orders, customers, new PricingService()),
    reports: new ReportService(orders),
  };
}

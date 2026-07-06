import { OrderRepository } from "../repository/orderRepository";
import { averageOrderValue, totalRevenue } from "../domain/reporting";

/** Reads orders and produces summary figures. */
export class ReportService {
  constructor(private orders: OrderRepository) {}

  revenue(): number {
    return totalRevenue(this.orders.all());
  }

  /** Average value across all recorded orders. */
  averageTicket(): number {
    return averageOrderValue(this.orders.all());
  }
}

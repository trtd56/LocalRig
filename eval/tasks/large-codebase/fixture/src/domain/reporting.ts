import type { Order } from "./types";
import { round2 } from "../util/decimal";
import { sumBy } from "../util/collection";

/** Total revenue across a set of orders (sum of their totals). */
export function totalRevenue(orders: Order[]): number {
  return sumBy(orders, (o) => o.total);
}

/** Mean order value, rounded to currency precision. */
export function averageOrderValue(orders: Order[]): number {
  if (orders.length === 0) return 0;
  return round2(totalRevenue(orders) / orders.length);
}

/** Count of orders in a given status. */
export function countByStatus(orders: Order[], status: Order["status"]): number {
  return orders.filter((o) => o.status === status).length;
}

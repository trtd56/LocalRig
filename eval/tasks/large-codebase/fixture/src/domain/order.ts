import type { Order, OrderLine, OrderStatus } from "./types";
import { InvalidTransitionError } from "./errors";
import { MAX_ORDER_LINES } from "../config/limits";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ["placed", "cancelled"],
  placed: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
};

/** Append a line, enforcing the per-order line cap. */
export function addLine(order: Order, line: OrderLine): Order {
  if (order.lines.length >= MAX_ORDER_LINES) throw new Error("too many order lines");
  return { ...order, lines: [...order.lines, line] };
}

/** Move an order to a new status, enforcing the state machine. */
export function transition(order: Order, to: OrderStatus): Order {
  if (!TRANSITIONS[order.status].includes(to)) {
    throw new InvalidTransitionError(order.status, to);
  }
  return { ...order, status: to };
}

/** Total number of lines on the order. */
export function lineCount(order: Order): number {
  return order.lines.length;
}

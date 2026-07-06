import { describe, expect, test } from "bun:test";
import { OrderRepository } from "../src/repository/orderRepository";
import { ReportService } from "../src/services/reportService";
import type { Order } from "../src/domain/types";

function order(id: string, total: number): Order {
  return { id, customerId: "c", lines: [], status: "placed", total };
}

// Reporting reaches the same money math from a different direction than
// checkout does. Averages must be rounded to whole cents.
describe("revenue report (integration)", () => {
  test("average ticket is rounded to cents", () => {
    const repo = new OrderRepository();
    for (const [id, t] of [["o1", 80], ["o2", 80], ["o3", 40]] as const) {
      repo.save(order(id, t));
    }
    const reports = new ReportService(repo);
    expect(reports.revenue()).toBe(200);
    expect(reports.averageTicket()).toBe(66.67);
  });

  test("average ticket rounds up on repeating decimals", () => {
    const repo = new OrderRepository();
    for (const [id, t] of [["a", 50], ["b", 50], ["c", 25]] as const) {
      repo.save(order(id, t));
    }
    const reports = new ReportService(repo);
    expect(reports.averageTicket()).toBe(41.67);
  });
});

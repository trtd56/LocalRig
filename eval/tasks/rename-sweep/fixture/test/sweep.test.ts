import { describe, expect, test } from "bun:test";
import { weeklySummary } from "../src/reports/weekly-summary";
import { revenueReport } from "../src/reports/revenue-report";
import { auditLine, auditRange } from "../src/reports/audit-log";
import { invoiceLine } from "../src/handlers/invoice";
import { orderConfirmation } from "../src/handlers/order-confirmation";
import { shipmentNotice } from "../src/handlers/shipment";
import { digestHeader } from "../src/jobs/daily-digest";
import { cleanupLog } from "../src/jobs/cleanup";
import { metricsRow } from "../src/jobs/metrics-export";
import { dashboardTile } from "../src/views/dashboard";
import { memberSince } from "../src/views/profile";
import { timelineEntry } from "../src/views/timeline";

// Constructed from local date components so the formatted output is
// independent of the machine's timezone (fmtDate/formatDate read local getters).
const d = new Date(2026, 0, 5, 9, 7); // 2026-01-05 09:07
const d2 = new Date(2026, 2, 20, 14, 30); // 2026-03-20 14:30

// The migration must preserve behaviour: these outputs are identical whether a
// caller uses the deprecated fmt.ts API or the new format.ts API. They fail if
// an argument is dropped, swapped, or mapped to the wrong option key.
describe("rename-sweep behaviour is preserved", () => {
  test("weeklySummary", () => {
    expect(weeklySummary(d, 1234.5)).toBe("Week of 2026-01-05: $1234.50");
  });

  test("revenueReport", () => {
    expect(revenueReport(1000, 80)).toBe("gross: 1000.00\ntax:   80.00");
  });

  test("auditLine", () => {
    expect(auditLine({ actor: "alice", action: "login", at: d })).toBe(
      "[2026-01-05 09:07] alice login",
    );
  });

  test("auditRange", () => {
    expect(auditRange(d, d2)).toBe("2026-01-05..2026-03-20");
  });

  test("invoiceLine", () => {
    expect(invoiceLine({ label: "widget", qty: 3, unitPrice: 2.5 })).toBe(
      "widget x3 @ 2.50 = 7.50",
    );
  });

  test("orderConfirmation", () => {
    expect(orderConfirmation("A-100", d, 42)).toBe(
      "Order A-100 placed 2026-01-05 — total 42.00",
    );
  });

  test("shipmentNotice", () => {
    expect(shipmentNotice("TRK9", d2)).toBe("TRK9 ships 03/20");
  });

  test("digestHeader", () => {
    expect(digestHeader(d)).toBe("Daily digest — 2026-01-05 (09:07)");
  });

  test("cleanupLog", () => {
    expect(cleanupLog(d2, 12.34)).toBe("cleanup @ 14:30 freed 12.3 MB");
  });

  test("metricsRow", () => {
    expect(metricsRow("api", 1.2, 9.876)).toBe("api\t1.200\t9.876");
  });

  test("dashboardTile", () => {
    expect(dashboardTile("users", 1500, d)).toBe("users: 1500 (updated 09:07)");
  });

  test("memberSince", () => {
    expect(memberSince(d2)).toBe("Member since 2026-03-20");
  });

  test("timelineEntry", () => {
    expect(timelineEntry({ title: "deploy", at: d2 })).toBe("03/20 14:30 — deploy");
  });
});

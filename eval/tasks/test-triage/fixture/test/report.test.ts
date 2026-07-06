import { describe, expect, test } from "bun:test";
import { buildReportTitle, summarizeTotals } from "../src/modules/report";

describe("buildReportTitle", () => {
  test("keeps short titles unchanged", () => {
    expect(buildReportTitle("Q1 Report")).toBe("Q1 Report");
  });

  test("truncates long titles to at most 20 characters", () => {
    const title = buildReportTitle("Quarterly Revenue and Expense Summary");
    expect(title.length).toBeLessThanOrEqual(20);
    expect(title).toBe("Quarterly Revenue...");
  });
});

describe("summarizeTotals", () => {
  test("computes total and average", () => {
    expect(summarizeTotals([10, 20, 30])).toEqual({ total: 60, avg: 20 });
  });

  test("handles a single value", () => {
    expect(summarizeTotals([5])).toEqual({ total: 5, avg: 5 });
  });
});

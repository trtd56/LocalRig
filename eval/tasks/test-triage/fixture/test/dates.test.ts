import { describe, expect, test } from "bun:test";
import { formatDate, daysBetween, isWithinRange } from "../src/utils/dates";

describe("formatDate", () => {
  test("formats an ISO date with slashes", () => {
    expect(formatDate("2024-03-05")).toBe("2024/03/05");
  });
});

describe("daysBetween", () => {
  test("counts whole days between two dates", () => {
    expect(daysBetween("2024-03-01", "2024-03-10")).toBe(9);
  });
});

describe("isWithinRange", () => {
  test("returns true for a date clearly inside the range", () => {
    expect(isWithinRange("2024-03-10", "2024-03-05", "2024-03-15")).toBe(true);
  });

  test("returns false for a date clearly outside the range", () => {
    expect(isWithinRange("2024-03-20", "2024-03-05", "2024-03-15")).toBe(false);
  });

  test("includes the start date (inclusive lower bound)", () => {
    expect(isWithinRange("2024-03-05", "2024-03-05", "2024-03-15")).toBe(true);
  });

  test("includes the end date (inclusive upper bound)", () => {
    expect(isWithinRange("2024-03-15", "2024-03-05", "2024-03-15")).toBe(true);
  });
});

import { truncate } from "../utils/strings";
import { sum, average } from "../utils/aggregate";

/** Builds a display title for a report, truncated to at most 20 characters. */
export function buildReportTitle(title: string): string {
  return truncate(title, 20);
}

export function summarizeTotals(nums: number[]): { total: number; avg: number } {
  return { total: sum(nums), avg: average(nums) };
}

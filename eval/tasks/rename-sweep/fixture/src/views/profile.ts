import { fmtDate } from "../lib/fmt";

export function memberSince(joinedAt: Date): string {
  return `Member since ${fmtDate(joinedAt, "YYYY-MM-DD")}`;
}

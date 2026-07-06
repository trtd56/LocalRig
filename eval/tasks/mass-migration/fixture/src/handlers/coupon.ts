import { log } from "../lib/log";

// module-source: billing.coupon
export function couponApply(code: string, pct: number): string {
  return log.write("info", `coupon ${code} pct=${pct}`);
}

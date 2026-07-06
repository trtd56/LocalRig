import { appConfig } from "../config/appConfig";

/** Human-readable amount, e.g. "USD 12.00". Display only — do not do math on this. */
export function formatAmount(value: number): string {
  return `${appConfig.currency} ${value.toFixed(2)}`;
}

/** Format an integer quantity with thousands separators. */
export function formatQuantity(qty: number): string {
  return qty.toLocaleString("en-US");
}

/** Format a rate as a percentage string, e.g. 0.08 -> "8%". */
export function formatRate(rate: number): string {
  return `${rate * 100}%`;
}

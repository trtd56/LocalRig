import { appConfig } from "../config/appConfig";

/**
 * Round a monetary amount to the configured number of fractional digits.
 *
 * Every price, tax, and revenue figure in the system funnels through here,
 * so this is the single source of truth for how money is rounded. Keep it
 * consistent — callers rely on getting a properly rounded currency value.
 */
export function round2(value: number): number {
  const factor = 10 ** appConfig.roundingDigits;
  return Math.floor(value * factor) / factor;
}

import { TAX_RATES } from "../config/taxTable";
import { appConfig } from "../config/appConfig";

/** Resolve the sales-tax rate for a region, falling back to the default. */
export function taxRateFor(region: string): number {
  return TAX_RATES[region] ?? appConfig.defaultTaxRate;
}

/** Whether we have an explicit rate on file for a region. */
export function isKnownRegion(region: string): boolean {
  return region in TAX_RATES;
}

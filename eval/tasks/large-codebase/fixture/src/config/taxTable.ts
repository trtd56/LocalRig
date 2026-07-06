/** Sales-tax rate lookup by region code. */
export const TAX_RATES: Record<string, number> = {
  US_CA: 0.0725,
  US_NY: 0.08,
  US_TX: 0.0625,
  EU_DE: 0.19,
  JP: 0.1,
};

/** Region assumed when a customer has no explicit region on file. */
export const DEFAULT_REGION = "US_NY";

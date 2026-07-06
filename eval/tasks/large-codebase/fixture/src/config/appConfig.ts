/** Global application configuration for the order-management system. */
export interface AppConfig {
  /** ISO currency code used across the app. */
  currency: string;
  /** Fallback sales-tax rate when a region is unknown. */
  defaultTaxRate: number;
  /** Number of fractional digits money is rounded to. */
  roundingDigits: number;
}

export const appConfig: AppConfig = {
  currency: "USD",
  defaultTaxRate: 0.08,
  roundingDigits: 2,
};

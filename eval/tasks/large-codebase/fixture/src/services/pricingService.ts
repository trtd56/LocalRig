import { orderTotal } from "../domain/pricing";
import { taxRateFor } from "../domain/tax";
import type { OrderLine } from "../domain/types";

/** Prices order lines according to a customer's tax region. */
export class PricingService {
  /** Payable total for a set of lines in the given tax region. */
  priceOrder(lines: OrderLine[], region: string): number {
    return orderTotal(lines, taxRateFor(region));
  }
}

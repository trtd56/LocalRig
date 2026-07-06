import { formatMoney } from "./lib/legacy-format";
import type { CartItem } from "./cart";

export function receiptLines(items: CartItem[], currency: string): string[] {
  return items.map(
    (i) => `${i.name} x${i.quantity}  ${formatMoney(i.unitPrice * i.quantity, currency)}`,
  );
}

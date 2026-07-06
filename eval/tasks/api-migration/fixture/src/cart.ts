import { formatMoney } from "./lib/legacy-format";

export interface CartItem {
  name: string;
  unitPrice: number;
  quantity: number;
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
}

export function cartSummary(items: CartItem[], currency: string): string {
  return `${items.length} items — ${formatMoney(cartTotal(items), currency)}`;
}

import { fmtMoney, discountCents } from "../lib/money";

export function cartLine(name: string, unitCents: number, qty: number, pct: number): string {
  const gross = unitCents * qty;
  const net = discountCents(gross, pct);
  return `${name} x${qty}: ${fmtMoney(net, "$")}`;
}

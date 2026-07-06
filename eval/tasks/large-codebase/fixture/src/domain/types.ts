/** Monetary amount in major currency units (e.g. dollars, not cents). */
export type Money = number;

export interface Product {
  sku: string;
  name: string;
  unitPrice: Money;
  category: string;
}

export interface OrderLine {
  sku: string;
  unitPrice: Money;
  quantity: number;
}

export type OrderStatus = "draft" | "placed" | "fulfilled" | "cancelled";

export interface Order {
  id: string;
  customerId: string;
  lines: OrderLine[];
  status: OrderStatus;
  total: Money;
}

export interface StockLevel {
  sku: string;
  onHand: number;
  reserved: number;
}

export interface Customer {
  id: string;
  name: string;
  taxRegion: string;
}

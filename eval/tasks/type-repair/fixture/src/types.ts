export interface Product {
  sku: string;
  name: string;
  price: number;
  quantity: number;
}

export type Discount =
  | { kind: "percent"; rate: number }
  | { kind: "fixed"; amount: number };

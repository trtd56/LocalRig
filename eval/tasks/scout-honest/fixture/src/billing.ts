export interface Invoice {
  id: string;
  customerId: string;
  totalCents: number;
}

export function createInvoice(customerId: string, totalCents: number): Invoice {
  return { id: `inv_${customerId}`, customerId, totalCents };
}

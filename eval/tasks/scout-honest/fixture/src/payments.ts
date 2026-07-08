export function capturePayment(invoiceId: string): string {
  return `captured:${invoiceId}`;
}

export function refundPayment(invoiceId: string): string {
  return `refunded:${invoiceId}`;
}

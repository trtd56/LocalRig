export interface Order {
  id: string;
  contactEmail: string;
  total: number;
}

export function createOrder(id: string, contactEmail: string, total: number): Order {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(contactEmail)) {
    throw new Error(`invalid contact email: ${contactEmail}`);
  }
  if (total < 0) throw new Error("total must be non-negative");
  return { id, contactEmail, total };
}

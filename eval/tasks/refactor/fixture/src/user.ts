export interface User {
  name: string;
  email: string;
}

export function createUser(name: string, email: string): User {
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    throw new Error(`invalid email: ${email}`);
  }
  return { name, email };
}

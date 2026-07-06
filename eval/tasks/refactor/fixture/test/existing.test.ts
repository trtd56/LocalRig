import { describe, expect, test } from "bun:test";
import { createUser } from "../src/user";
import { createOrder } from "../src/order";

describe("existing behavior", () => {
  test("createUser accepts valid email", () => {
    expect(createUser("a", "a@example.com").email).toBe("a@example.com");
  });
  test("createUser rejects invalid email", () => {
    expect(() => createUser("a", "not-an-email")).toThrow();
  });
  test("createOrder accepts valid email", () => {
    expect(createOrder("o1", "b@example.com", 10).total).toBe(10);
  });
  test("createOrder rejects invalid email", () => {
    expect(() => createOrder("o1", "nope", 10)).toThrow();
  });
  test("createOrder rejects negative total", () => {
    expect(() => createOrder("o1", "b@example.com", -1)).toThrow();
  });
});

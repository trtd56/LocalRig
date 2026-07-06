import { describe, expect, test } from "bun:test";
import { addLine, lineCount, transition } from "../src/domain/order";
import { InvalidTransitionError } from "../src/domain/errors";
import type { Order } from "../src/domain/types";

const base: Order = { id: "o1", customerId: "c1", lines: [], status: "draft", total: 0 };

describe("order state machine", () => {
  test("draft can be placed then fulfilled", () => {
    const placed = transition(base, "placed");
    expect(placed.status).toBe("placed");
    expect(transition(placed, "fulfilled").status).toBe("fulfilled");
  });

  test("illegal transition throws", () => {
    expect(() => transition(base, "fulfilled")).toThrow(InvalidTransitionError);
  });

  test("addLine appends a line", () => {
    const withLine = addLine(base, { sku: "a", unitPrice: 1, quantity: 1 });
    expect(lineCount(withLine)).toBe(1);
  });

  test("a fresh order has no lines", () => {
    expect(lineCount(base)).toBe(0);
  });
});

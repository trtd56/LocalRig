import { describe, expect, test } from "bun:test";
import { withRetry } from "../src/retry";

describe("withRetry", () => {
  test("succeeds first try", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { maxAttempts: 3 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("makes exactly maxAttempts attempts before giving up", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(3);
  });

  test("succeeds on the final attempt", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
        return "recovered";
      },
      { maxAttempts: 2 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });
});

import { describe, expect, test } from "bun:test";
import { buildCheckRepairPrompt, canRetryCheck } from "../src/check.ts";

describe("check retry policy", () => {
  test("allows attempts through the configured retry count", () => {
    const base = { maxRetries: 2, startedAtMs: 1_000, maxTimeMs: 0, nowMs: 10_000 };
    expect(canRetryCheck({ ...base, attempts: 1 })).toBe(true);
    expect(canRetryCheck({ ...base, attempts: 2 })).toBe(true);
    expect(canRetryCheck({ ...base, attempts: 3 })).toBe(false);
  });

  test("respects the wall-clock budget when one is configured", () => {
    expect(
      canRetryCheck({ attempts: 1, maxRetries: 2, startedAtMs: 1_000, maxTimeMs: 5_000, nowMs: 5_999 }),
    ).toBe(true);
    expect(
      canRetryCheck({ attempts: 1, maxRetries: 2, startedAtMs: 1_000, maxTimeMs: 5_000, nowMs: 6_000 }),
    ).toBe(false);
  });
});

describe("buildCheckRepairPrompt", () => {
  test("includes the exact command, exit code, and output tail", () => {
    const prompt = buildCheckRepairPrompt({
      command: "bash test/verify.sh",
      exit_code: 1,
      attempts: 1,
      output_tail: "expected first line to match",
    });
    expect(prompt).toContain("Command: bash test/verify.sh");
    expect(prompt).toContain("Exit code: 1");
    expect(prompt).toContain("expected first line to match");
  });
});

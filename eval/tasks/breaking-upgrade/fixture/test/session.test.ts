import { describe, expect, test } from "bun:test";
import { endSession, loadSession, makeSessionStore, saveSession } from "../src/session";

describe("session", () => {
  test("saves and loads a session token", () => {
    const store = makeSessionStore();
    saveSession(store, "abc", "tok-123");
    expect(loadSession(store, "abc")).toBe("tok-123");
  });

  test("loadSession returns null for a session that was never created", () => {
    const store = makeSessionStore();
    expect(loadSession(store, "missing")).toBeNull();
  });

  test("endSession is a no-op for a session that does not exist", () => {
    const store = makeSessionStore();
    expect(() => endSession(store, "ghost")).not.toThrow();
  });

  test("saveSession keeps working for tokens that fit under the old 1KB ceiling", () => {
    const store = makeSessionStore();
    const token = "a".repeat(500);
    expect(() => saveSession(store, "big", token)).not.toThrow();
    expect(loadSession(store, "big")).toBe(token);
  });

  test("saveSession still rejects tokens over 1KB", () => {
    const store = makeSessionStore();
    expect(() => saveSession(store, "huge", "a".repeat(2000))).toThrow(
      "session token too large",
    );
  });
});

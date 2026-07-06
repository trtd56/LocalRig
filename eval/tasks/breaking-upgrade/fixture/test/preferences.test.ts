import { describe, expect, test } from "bun:test";
import { getPreference, makePreferencesStore, setPreference } from "../src/preferences";

describe("preferences", () => {
  test("sets and gets a preference", () => {
    const store = makePreferencesStore();
    expect(setPreference(store, "theme", "dark")).toEqual({ success: true });
    expect(getPreference(store, "theme", "light")).toBe("dark");
  });

  test("returns the fallback for a preference that was never set", () => {
    const store = makePreferencesStore();
    expect(getPreference(store, "missing", "default")).toBe("default");
  });

  test("rejects an empty key with a friendly message", () => {
    const store = makePreferencesStore();
    expect(setPreference(store, "", "x")).toEqual({
      success: false,
      message: "preference key must not be empty",
    });
  });

  test("rejects a value over the size limit", () => {
    const store = makePreferencesStore();
    expect(setPreference(store, "bio", "x".repeat(600))).toEqual({
      success: false,
      message: "preference value too long",
    });
  });
});

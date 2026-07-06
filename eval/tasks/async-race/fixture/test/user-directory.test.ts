import { describe, expect, test } from "bun:test";
import { UserDirectory, type UserProfile } from "../src/user-directory";

describe("UserDirectory", () => {
  test("getUser caches so a repeated lookup does not re-fetch", async () => {
    let fetchCount = 0;
    const dir = new UserDirectory(async (id) => {
      fetchCount++;
      return { id, name: `user-${id}` };
    });

    const first = await dir.getUser("42");
    const second = await dir.getUser("42");

    expect(first).toEqual({ id: "42", name: "user-42" } satisfies UserProfile);
    expect(second).toEqual(first);
    expect(fetchCount).toBe(1);
  });

  test("different user ids are fetched independently", async () => {
    const seen: string[] = [];
    const dir = new UserDirectory(async (id) => {
      seen.push(id);
      return { id, name: `user-${id}` };
    });

    await dir.getUser("1");
    await dir.getUser("2");

    expect(seen).toEqual(["1", "2"]);
  });

  test("refreshUser forces the next getUser call to re-fetch", async () => {
    let fetchCount = 0;
    const dir = new UserDirectory(async (id) => {
      fetchCount++;
      return { id, name: `user-${id}-v${fetchCount}` };
    });

    const before = await dir.getUser("7");
    dir.refreshUser("7");
    const after = await dir.getUser("7");

    expect(before.name).toBe("user-7-v1");
    expect(after.name).toBe("user-7-v2");
    expect(fetchCount).toBe(2);
  });
});

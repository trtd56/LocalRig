import { describe, expect, test } from "bun:test";
import { filterUpcoming, groupEventsByDay, filterEventsInRange } from "../src/modules/schedule";
import type { CalendarEvent } from "../src/types";

describe("filterUpcoming", () => {
  test("keeps only events strictly after today", () => {
    const events: CalendarEvent[] = [
      { title: "past", date: "2024-01-01" },
      { title: "future", date: "2024-06-01" },
    ];
    expect(filterUpcoming(events, "2024-03-01").map((e) => e.title)).toEqual(["future"]);
  });
});

describe("groupEventsByDay", () => {
  test("groups events sharing the same date", () => {
    const events: CalendarEvent[] = [
      { title: "standup", date: "2024-03-01" },
      { title: "review", date: "2024-03-01" },
      { title: "launch", date: "2024-03-02" },
    ];
    const grouped = groupEventsByDay(events);
    expect(grouped["2024-03-01"]!.map((e) => e.title)).toEqual(["standup", "review"]);
    expect(grouped["2024-03-02"]!.map((e) => e.title)).toEqual(["launch"]);
  });
});

describe("filterEventsInRange", () => {
  test("keeps events clearly inside the range", () => {
    const events: CalendarEvent[] = [
      { title: "a", date: "2024-03-10" },
      { title: "b", date: "2024-04-01" },
    ];
    expect(
      filterEventsInRange(events, "2024-03-05", "2024-03-15").map((e) => e.title),
    ).toEqual(["a"]);
  });

  test("drops events clearly outside the range", () => {
    const events: CalendarEvent[] = [{ title: "a", date: "2024-01-01" }];
    expect(filterEventsInRange(events, "2024-03-05", "2024-03-15")).toEqual([]);
  });
});

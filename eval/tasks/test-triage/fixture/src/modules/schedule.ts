import { isWithinRange } from "../utils/dates";
import type { CalendarEvent } from "../types";

export function filterUpcoming(events: CalendarEvent[], todayIso: string): CalendarEvent[] {
  return events.filter((e) => e.date > todayIso);
}

export function groupEventsByDay(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
  const out: Record<string, CalendarEvent[]> = {};
  for (const e of events) {
    (out[e.date] ??= []).push(e);
  }
  return out;
}

export function filterEventsInRange(
  events: CalendarEvent[],
  start: string,
  end: string,
): CalendarEvent[] {
  return events.filter((e) => isWithinRange(e.date, start, end));
}

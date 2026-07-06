import { fmtDate } from "../lib/fmt";

export interface TimelineEvent {
  title: string;
  at: Date;
}

export function timelineEntry(e: TimelineEvent): string {
  return `${fmtDate(e.at, "MM/DD")} ${fmtDate(e.at, "HH:mm")} — ${e.title}`;
}

import { fmtDate } from "../lib/fmt";

export interface AuditEntry {
  actor: string;
  action: string;
  at: Date;
}

export function auditLine(entry: AuditEntry): string {
  return `[${fmtDate(entry.at, "YYYY-MM-DD HH:mm")}] ${entry.actor} ${entry.action}`;
}

export function auditRange(from: Date, to: Date): string {
  return `${fmtDate(from, "YYYY-MM-DD")}..${fmtDate(to, "YYYY-MM-DD")}`;
}

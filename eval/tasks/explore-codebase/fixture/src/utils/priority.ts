export type Priority = "high" | "medium" | "low";

export function parsePriority(raw: string): Priority {
  const v = raw.trim().toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  throw new Error(`unknown priority: ${raw}`);
}

export function priorityWeight(p: Priority): number {
  return p === "high" ? 0 : p === "medium" ? 1 : 2;
}

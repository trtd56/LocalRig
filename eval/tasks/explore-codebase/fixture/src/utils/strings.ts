export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function padId(id: number): string {
  return String(id).padStart(6, "0");
}

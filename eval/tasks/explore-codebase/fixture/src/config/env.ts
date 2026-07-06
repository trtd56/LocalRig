// Environment overrides. Numeric values here are fallbacks for local dev only.
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const PORT = envInt("TASKMAN_PORT", 8080);
export const POLL_INTERVAL_MS = envInt("TASKMAN_POLL_MS", 1500);

import { log } from "../lib/log";

// module-source: core.ratelimit
export function rateLimitHit(ip: string, n: number): string {
  return log.write("warn", `limit ${ip} n=${n}`);
}

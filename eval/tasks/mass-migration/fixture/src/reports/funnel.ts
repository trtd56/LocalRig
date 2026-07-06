import { log } from "../lib/log";

// module-source: analytics.funnel
export function funnelStep(step: string, rate: number): string {
  return log.write("info", `funnel ${step} rate=${rate}`);
}

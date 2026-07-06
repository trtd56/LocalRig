import { log } from "../lib/log";

// module-source: ext.s3
export function s3Put(key: string, bytes: number): string {
  return log.write("debug", `put ${key} bytes=${bytes}`);
}

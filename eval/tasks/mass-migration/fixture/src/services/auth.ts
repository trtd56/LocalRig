import { log } from "../lib/log";

// module-source: core.auth
export function authLogin(user: string): string {
  return log.write("info", `login ${user}`);
}
export function authLogout(user: string): string {
  return log.write("debug", `logout ${user}`);
}

import { log } from "../lib/log";

// module-source: ext.slack
export function slackPost(ch: string): string {
  return log.write("info", `post ${ch}`);
}

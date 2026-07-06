import { redactSecrets } from "../log/logger";
import { DEFAULT_TIMEOUT_MS } from "../config/constants";

export async function postJob(baseUrl: string, body: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      body,
      signal: controller.signal,
    });
    console.log(redactSecrets(`POST /jobs -> ${res.status} (${body})`));
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

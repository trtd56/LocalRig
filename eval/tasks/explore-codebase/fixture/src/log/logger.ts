const SECRET_KEYS = /(token|password|secret|api[_-]?key)=([^\s&]+)/gi;

/** Mask credential-looking values before a line reaches any log sink. */
export function redactSecrets(line: string): string {
  return line.replace(SECRET_KEYS, "$1=***");
}

export function info(msg: string): void {
  console.log(`[info] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[warn] ${msg}`);
}

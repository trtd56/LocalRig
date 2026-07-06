// DEPRECATED logging module. Replaced by src/lib/logger.ts (structured
// `logger.emit({ level, msg, source })`). Delete this file once every caller
// has migrated off `log.write`.
export const log = {
  write(level: string, msg: string): string {
    return `[${level}] ${msg}`;
  },
};

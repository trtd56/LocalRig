export type Level = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: Level;
  msg: string;
  /** Emitting module, e.g. "billing.invoice". Required by the new API. */
  source: string;
}

/**
 * Structured logging API. Every record carries a `source` tag so logs can be
 * filtered by subsystem. Returns the formatted line for testability.
 */
export const logger = {
  emit(record: LogRecord): string {
    return `[${record.level}] (${record.source}) ${record.msg}`;
  },
};

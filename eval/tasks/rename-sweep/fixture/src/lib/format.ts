const pad2 = (n: number): string => String(n).padStart(2, "0");

export interface DateFormatOptions {
  date: Date;
  pattern: string;
}

/** Date formatter: token replacement over YYYY / MM / DD / HH / mm. */
export function formatDate({ date, pattern }: DateFormatOptions): string {
  return pattern
    .replace("YYYY", String(date.getFullYear()))
    .replace("MM", pad2(date.getMonth() + 1))
    .replace("DD", pad2(date.getDate()))
    .replace("HH", pad2(date.getHours()))
    .replace("mm", pad2(date.getMinutes()));
}

export interface NumFormatOptions {
  value: number;
  decimals: number;
}

/** Number formatter: fixed number of decimal places. */
export function formatNum({ value, decimals }: NumFormatOptions): string {
  return value.toFixed(decimals);
}

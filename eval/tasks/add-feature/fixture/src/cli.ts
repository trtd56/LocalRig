export interface Item {
  name: string;
  size: number;
}

export function formatOutput(items: Item[], format: string): string {
  if (format === "table") {
    const width = Math.max(4, ...items.map((i) => i.name.length));
    const header = "name".padEnd(width) + "  size";
    const rows = items.map((i) => i.name.padEnd(width) + "  " + i.size);
    return [header, ...rows].join("\n");
  }
  return items.map((i) => `${i.name} ${i.size}`).join("\n");
}

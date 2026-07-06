// Aggregates tag usage from an event log and prints "tag: count" lines
// (sorted by tag) followed by a total event count.
import * as fs from "node:fs";

interface EventRecord {
  user: string;
  action: string;
  metadata?: { tags?: string[] };
}

const file = process.argv[2];
if (!file) {
  console.error("usage: bun src/main.ts <events.json>");
  process.exit(1);
}

const events: EventRecord[] = JSON.parse(fs.readFileSync(file, "utf8"));

const counts = new Map<string, number>();
for (const event of events) {
  for (const tag of event.metadata.tags) {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
}

for (const [tag, n] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`${tag}: ${n}`);
}
console.log(`events: ${events.length}`);

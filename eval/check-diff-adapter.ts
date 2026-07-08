#!/usr/bin/env bun
// Deterministic parser/citation-recall smoke check. It never calls an LLM.
import { parseUnifiedDiff, verifyDiffCitations } from "../src/diff.ts";

const fixture = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1,2 +1,2 @@
-export const value = "old";
+export const value = "new";
 export const stable = true;
`;

const snapshot = parseUnifiedDiff(fixture);
const lines = snapshot.files[0]!.hunks[0]!.lines;
const expected = lines.filter((line) => line.kind !== "context");
const citations = expected.map((line) => ({
  file: "(diff snapshot)",
  start_line: line.snapshot_line,
  end_line: line.snapshot_line,
  quote: line.kind === "deleted" ? 'value = "old"' : 'value = "new"',
}));
citations.push({ file: "(diff snapshot)", start_line: expected[0]!.snapshot_line, end_line: expected[0]!.snapshot_line, quote: "fabricated" });

const checked = verifyDiffCitations(snapshot, citations);
const recall = checked.verified.length / expected.length;
const result = {
  expected: expected.length,
  verified: checked.verified.length,
  dropped: checked.dropped.length,
  recall,
  line_types: checked.verified.map((citation) => citation.line_type),
};
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (recall !== 1 || checked.dropped.length !== 1) process.exit(1);

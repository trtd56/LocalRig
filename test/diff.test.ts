import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseUnifiedDiff, preprocessDiff, verifyDiffCitations } from "../src/diff.ts";
import { cmdDiff, cmdFeedback } from "../src/index.ts";
import { computeStats, loadSession } from "../src/session.ts";

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const before = true;
-const removed = "old";
+const added = "new";
 export default before;
@@ -10,2 +10,3 @@ function later() {
   keep();
+  extra();
   done();
`;

const FILE_VARIANTS = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+first
+second
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-forever
diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
`;

const BINARY_WITH_SPACES = `diff --git a/空 白.bin b/空 白.bin
index 1111111..2222222 100644
Binary files a/空 白.bin and b/空 白.bin differ
`;

const BINARY_QUOTED_OCTAL = `diff --git "a/\\347\\251\\272 \\347\\231\\275.bin" "b/\\347\\251\\272 \\347\\231\\275.bin"
index 1111111..2222222 100644
Binary files "a/\\347\\251\\272 \\347\\231\\275.bin" and "b/\\347\\251\\272 \\347\\231\\275.bin" differ
`;

describe("unified diff adapter", () => {
  test("preserves file/hunk boundaries and both-side line positions", () => {
    const snapshot = parseUnifiedDiff(MODIFIED);
    expect(snapshot.files).toHaveLength(1);
    const file = snapshot.files[0]!;
    expect(file.path).toBe("src/a.ts");
    expect(file.status).toBe("modified");
    expect(file.hunks).toHaveLength(2);
    const deleted = file.hunks[0]!.lines.find((line) => line.kind === "deleted")!;
    const added = file.hunks[0]!.lines.find((line) => line.kind === "added")!;
    expect(deleted).toMatchObject({ text: 'const removed = "old";', old_line: 2, new_line: null });
    expect(added).toMatchObject({ text: 'const added = "new";', old_line: null, new_line: 2 });
    expect(file.hunks[1]!.lines.find((line) => line.kind === "added")).toMatchObject({ old_line: null, new_line: 11 });
    expect(snapshot.sha256).toHaveLength(64);
  });

  test("recognizes added, deleted, and metadata-only renamed files", () => {
    const snapshot = parseUnifiedDiff(FILE_VARIANTS);
    expect(snapshot.files.map((file) => [file.path, file.status])).toEqual([
      ["new.txt", "added"],
      ["old.txt", "deleted"],
      ["new-name.ts", "renamed"],
    ]);
    expect(snapshot.files[0]!.hunks[0]!.lines.every((line) => line.old_line === null)).toBe(true);
    expect(snapshot.files[1]!.hunks[0]!.lines.every((line) => line.new_line === null)).toBe(true);
  });

  test("parses metadata-only binary paths containing spaces and Unicode", () => {
    const unquoted = parseUnifiedDiff(BINARY_WITH_SPACES).files[0]!;
    expect(unquoted).toMatchObject({ old_path: "空 白.bin", new_path: "空 白.bin", path: "空 白.bin" });
    expect(unquoted.hunks).toEqual([]);

    const quoted = parseUnifiedDiff(BINARY_QUOTED_OCTAL).files[0]!;
    expect(quoted).toMatchObject({ old_path: "空 白.bin", new_path: "空 白.bin", path: "空 白.bin" });
    expect(quoted.hunks).toEqual([]);
  });

  test("does not confuse changed content beginning with header markers", () => {
    const text = `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
--- removed heading
+++ added heading
`;
    const hunk = parseUnifiedDiff(text).files[0]!.hunks[0]!;
    expect(hunk.lines.map((line) => [line.kind, line.text])).toEqual([
      ["deleted", "-- removed heading"],
      ["added", "++ added heading"],
    ]);
  });

  test("verifies additions and deletions against snapshot and drops fabricated quotes", () => {
    const snapshot = parseUnifiedDiff(MODIFIED);
    const deletedLine = snapshot.files[0]!.hunks[0]!.lines.find((line) => line.kind === "deleted")!;
    const addedLine = snapshot.files[0]!.hunks[0]!.lines.find((line) => line.kind === "added")!;
    const checked = verifyDiffCitations(snapshot, [
      { file: "(diff snapshot)", start_line: deletedLine.snapshot_line, end_line: deletedLine.snapshot_line, quote: "removed" },
      { file: "(diff snapshot)", start_line: addedLine.snapshot_line, end_line: addedLine.snapshot_line, quote: "added" },
      { file: "(diff snapshot)", start_line: addedLine.snapshot_line, end_line: addedLine.snapshot_line, quote: "fabricated" },
    ]);
    expect(checked.verified.map((citation) => citation.line_type)).toEqual(["deleted", "added"]);
    expect(checked.verified[0]).toMatchObject({ path: "src/a.ts", old_line: 2, new_line: null, hunk: 1 });
    expect(checked.verified[1]).toMatchObject({ path: "src/a.ts", old_line: null, new_line: 2, hunk: 1 });
    expect(checked.dropped).toHaveLength(1);
    expect(checked.verified[0]!.snapshot_sha256).toBe(snapshot.sha256);
  });

  test("rejects empty, arbitrary, malformed-header, and truncated-hunk input", () => {
    expect(() => parseUnifiedDiff("")).toThrow("empty");
    expect(() => parseUnifiedDiff("hello\nworld\n")).toThrow("not a unified git diff");
    expect(() => parseUnifiedDiff("+++ b/a\n")).toThrow("without file");
    expect(() => parseUnifiedDiff("--- a/a\n+++ b/a\n")).toThrow("no hunks");
    expect(() => parseUnifiedDiff("--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n+new\n")).toThrow("hunk line counts");
    expect(() => parseUnifiedDiff("--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n+extra\n")).toThrow("extra line");
  });
});

describe("diff preprocessing", () => {
  test("returns the shared contract with diff-specific citation locations", async () => {
    const snapshot = parseUnifiedDiff(MODIFIED);
    const line = snapshot.files[0]!.hunks[0]!.lines.find((candidate) => candidate.kind === "deleted")!;
    const result = await preprocessDiff({
      query: "what changed?",
      text: MODIFIED,
      numCtx: 4096,
      budget: 300,
    }, {
      estimator: (text) => Math.ceil(text.length / 4),
      complete: async () => ({
        text: JSON.stringify({
          answer: "The old declaration was removed.",
          not_found: false,
          citations: [
            { file: "(diff snapshot)", start_line: line.snapshot_line, end_line: line.snapshot_line, quote: "removed" },
            { file: "(diff snapshot)", start_line: line.snapshot_line, end_line: line.snapshot_line, quote: "not there" },
          ],
          omitted: [],
        }),
        promptTokens: 120,
        evalTokens: 20,
      }),
    });
    expect(result.digest.input_kind).toBe("diff");
    expect(result.digest.metrics).toMatchObject({ prompt_tokens: 120, completion_tokens: 20 });
    expect(result.digest.metrics.output_tokens).toBeGreaterThan(0);
    expect(result.digest.metrics.compression_ratio).toBeGreaterThan(0);
    expect(result.digest.citations).toHaveLength(1);
    expect(result.digest.citations[0]).toMatchObject({ line_type: "deleted", old_line: 2, new_line: null });
    expect(result.digest.citations_dropped).toBe(1);
  });

  test("accepts natural file paths, repairs line drift, and keeps added/deleted citations", async () => {
    const snapshot = parseUnifiedDiff(MODIFIED);
    const deleted = snapshot.files[0]!.hunks[0]!.lines.find((line) => line.kind === "deleted")!;
    const added = snapshot.files[0]!.hunks[0]!.lines.find((line) => line.kind === "added")!;
    const result = await preprocessDiff({
      query: "what changed?",
      text: MODIFIED,
      numCtx: 4096,
      budget: 300,
    }, {
      estimator: (text) => Math.ceil(text.length / 4),
      complete: async () => ({
        text: JSON.stringify({
          answer: "The old declaration was replaced.",
          not_found: false,
          citations: [
            {
              file: "src/a.ts",
              start_line: deleted.snapshot_line + 1,
              end_line: deleted.snapshot_line + 1,
              quote: '-const removed = "old";',
            },
            {
              file: "src/a.ts",
              start_line: added.snapshot_line + 1,
              end_line: added.snapshot_line + 1,
              quote: '+const added = "new";',
            },
          ],
          omitted: [],
        }),
      }),
    });
    expect(result.digest.citations).toHaveLength(2);
    expect(result.digest.citations.map((citation) => citation.line_type)).toEqual(["deleted", "added"]);
    expect(result.digest.citations.map((citation) => citation.path)).toEqual(["src/a.ts", "src/a.ts"]);
    expect(result.digest.citations_dropped).toBe(0);
  });

  test("never relocates an actual-path citation into another file with the same quote", async () => {
    const text = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-shared
+a-only
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-shared
+b-only
`;
    const snapshot = parseUnifiedDiff(text);
    const wrongFileLine = snapshot.files[0]!.hunks[0]!.lines[0]!.snapshot_line;
    const expectedLine = snapshot.files[1]!.hunks[0]!.lines[0]!.snapshot_line;
    const result = await preprocessDiff({ query: "b?", text, numCtx: 4096, budget: 200 }, {
      estimator: (value) => Math.ceil(value.length / 4),
      complete: async () => ({
        text: JSON.stringify({
          answer: "b changed",
          not_found: false,
          citations: [{ file: "b.ts", start_line: wrongFileLine, end_line: wrongFileLine, quote: "-shared" }],
          omitted: [],
        }),
      }),
    });
    expect(result.digest.citations).toHaveLength(1);
    expect(result.digest.citations[0]).toMatchObject({ path: "b.ts", snapshot_line: expectedLine });
    expect(result.digest.citations_dropped).toBe(0);
  });
});

describe("cmdDiff", () => {
  let home: string;
  let cwd: string;
  let logs: string[];
  const originalLog = console.log;
  const originalWrite = process.stderr.write;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-diff-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-diff-cwd-"));
    process.env.LH_HOME = home;
    logs = [];
    console.log = (value?: unknown) => { logs.push(String(value ?? "")); };
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    console.log = originalLog;
    process.stderr.write = originalWrite;
    delete process.env.LH_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const notFound = async () => ({
    text: JSON.stringify({ answer: "No relevant change.", not_found: true, citations: [], omitted: [] }),
    promptTokens: 10,
    evalTokens: 5,
  });

  test("uses stdin, saves kind=diff, and emits the existing digest envelope", async () => {
    const rc = await cmdDiff([
      "-q", "relevant?", "--cwd", cwd, "--json", "--session-id", "stdin-diff",
      "--caller", "codex", "--hardware", "test-hardware", "--integration-version", "2.1.0",
    ], {
      readStdin: async () => MODIFIED,
      complete: notFound,
    });
    expect(rc).toBe(0);
    const record = loadSession("stdin-diff")!;
    expect(record.kind).toBe("diff");
    expect(record.dimensions).toMatchObject({
      caller: "codex",
      hardware: "test-hardware",
      integrationVersion: "2.1.0",
      localrigVersion: "0.1.0",
    });
    expect(JSON.parse(record.result).input_kind).toBe("diff");
    expect(JSON.parse(logs.at(-1)!).digest.not_found).toBe(true);
    expect(cmdFeedback(["stdin-diff", "pass", "--source", "test"])).toBe(0);
    const diffStats = computeStats({ byKind: true }).byKind!.find((item) => item.kind === "diff")!;
    expect(diffStats).toMatchObject({ graded: 1, pass: 1, fail: 0 });
  });

  test("falls back to safe git argv and supports staged/base flags", async () => {
    const seen: { args?: string[]; cwd?: string } = {};
    const rc = await cmdDiff([
      "-q", "relevant?", "--cwd", cwd, "--staged", "--base", "main", "--json", "--session-id", "git-diff",
    ], {
      runGit: async (args, dir) => {
        seen.args = args;
        seen.cwd = dir;
        return MODIFIED;
      },
      complete: notFound,
    });
    expect(rc).toBe(0);
    expect(seen.args).toEqual(["diff", "--no-ext-diff", "--no-color", "--cached", "main", "--"]);
    expect(seen.cwd).toBe(cwd);
  });

  test("acquires the real cwd working-tree diff when stdin is absent", async () => {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd }).exitCode).toBe(0);
    fs.writeFileSync(path.join(cwd, "value.txt"), "old\n");
    expect(Bun.spawnSync(["git", "add", "value.txt"], { cwd }).exitCode).toBe(0);
    expect(Bun.spawnSync([
      "git", "-c", "user.name=LocalRig Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture",
    ], { cwd }).exitCode).toBe(0);
    fs.writeFileSync(path.join(cwd, "value.txt"), "new\n");
    const rc = await cmdDiff([
      "-q", "what changed?", "--cwd", cwd, "--json", "--session-id", "real-git-diff",
    ], { complete: notFound });
    expect(rc).toBe(0);
    expect(loadSession("real-git-diff")!.kind).toBe("diff");
  });

  test("applies max-time to git acquisition, aborts it, and saves a timeout session", async () => {
    let acquisitionAborted = false;
    const rc = await cmdDiff([
      "-q", "what changed?", "--cwd", cwd, "--max-time", "0.01", "--json", "--session-id", "git-timeout",
    ], {
      runGit: async (_args, _dir, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          acquisitionAborted = true;
          reject(new Error("git acquisition aborted"));
        }, { once: true });
      }),
      complete: notFound,
    });
    expect(rc).toBe(1);
    expect(acquisitionAborted).toBe(true);
    const record = loadSession("git-timeout")!;
    expect(record.status).toBe("timeout");
    expect(record.errorKind).toBeUndefined();
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ status: "timeout" });
  });

  test("reports empty stdin, git failure, and invalid diff as structured config errors", async () => {
    expect(await cmdDiff(["-q", "x", "--base", "--json"], { complete: notFound })).toBe(1);
    expect(JSON.parse(logs.pop()!).error_kind).toBe("config");

    expect(await cmdDiff(["-q", "x", "--json"], { readStdin: async () => "", complete: notFound })).toBe(1);
    expect(JSON.parse(logs.pop()!).error_kind).toBe("config");

    expect(await cmdDiff(["-q", "x", "--json"], {
      runGit: async () => { throw new Error("not a repository"); },
      complete: notFound,
    })).toBe(1);
    expect(JSON.parse(logs.pop()!).error_kind).toBe("config");

    let called = false;
    expect(await cmdDiff(["-q", "x", "--json", "--session-id", "invalid-diff"], {
      readStdin: async () => "not a diff",
      complete: async () => { called = true; return notFound(); },
    })).toBe(1);
    expect(called).toBe(false);
    expect(loadSession("invalid-diff")!.errorKind).toBe("config");
    expect(JSON.parse(logs.pop()!).error_kind).toBe("config");
  });
});

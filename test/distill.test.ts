import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DistillConfigError,
  distill,
  mergeDigests,
  parseDigest,
  planChunks,
  verifyCitations,
  type Digest,
} from "../src/distill.ts";
import { cmdDistill } from "../src/index.ts";
import { loadSession } from "../src/session.ts";
import type { ChatMessage, ChatRequestOptions } from "../src/types.ts";

const estimator = (text: string) => Math.ceil(text.length / 10);

describe("planChunks", () => {
  test("keeps small files together until the token budget is exceeded", () => {
    const chunks = planChunks(
      [
        { file: "a.txt", text: "alpha" },
        { file: "b.txt", text: "bravo" },
      ],
      50,
      estimator,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sources.map((s) => s.file)).toEqual(["a.txt", "b.txt"]);
  });

  test("splits an oversized file by lines while preserving original line numbers", () => {
    const chunks = planChunks(
      [{ file: "big.log", text: ["one ".repeat(20), "two ".repeat(20), "three ".repeat(20), "four ".repeat(20)].join("\n") }],
      50,
      (text) => text.length,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.sources[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.sources[0]!.endLine).toBe(4);
  });

  test("truncates an oversized single line without emitting an oversized chunk", () => {
    const chunks = planChunks([{ file: "huge.log", text: "x".repeat(1_000) }], 80, (text) => text.length);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.estimatedTokens).toBeLessThanOrEqual(80);
    expect(chunks[0]!.sources[0]!.startLine).toBe(1);
    expect((chunks[0]!.omitted ?? []).join("\n")).toContain("single line exceeded");
  });

  test("plans a large split log with a bounded number of estimator calls", () => {
    let calls = 0;
    const text = Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join("\n");
    const budget = Math.floor(text.length / 2);
    const chunks = planChunks([{ file: "large.log", text }], budget, (value) => {
      calls++;
      return value.length;
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.estimatedTokens <= budget)).toBe(true);
    expect(calls).toBeLessThan(200);
  });
});

describe("parseDigest", () => {
  test("accepts fenced JSON and normalizes citation line numbers", () => {
    const parsed = parseDigest(
      '```json\n{"answer":"x","not_found":false,"citations":[{"file":"a","start_line":1.9,"end_line":1,"quote":"q"}],"omitted":[]}\n```',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.digest!.citations[0]).toEqual({ file: "a", start_line: 1, end_line: 1, quote: "q" });
  });

  test("reports schema errors without throwing", () => {
    const parsed = parseDigest('{"answer":"x","not_found":"no","citations":[],"omitted":[]}');
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("not_found");
  });

  test("ignores model-supplied citations_dropped", () => {
    const parsed = parseDigest(
      '{"answer":"x","not_found":false,"citations":[],"omitted":[],"citations_dropped":999}',
    );
    expect(parsed.digest!.citations_dropped).toBe(0);
  });
});

describe("verifyCitations", () => {
  const fileText = ["first line", "root cause: missing export", "later failure"].join("\n");

  test("keeps exact citations", () => {
    const out = verifyCitations(
      [{ file: "log.txt", start_line: 2, end_line: 2, quote: "root cause" }],
      () => fileText,
    );
    expect(out.verified).toEqual([{ file: "log.txt", start_line: 2, end_line: 2, quote: "root cause" }]);
    expect(out.dropped).toHaveLength(0);
  });

  test("clamps exact citations to the line where the quote actually appears", () => {
    const out = verifyCitations(
      [{ file: "log.txt", start_line: 2, end_line: 99, quote: "root cause" }],
      () => fileText,
    );
    expect(out.verified).toEqual([{ file: "log.txt", start_line: 2, end_line: 2, quote: "root cause" }]);
  });

  test("repairs nearby line drift", () => {
    const out = verifyCitations(
      [{ file: "log.txt", start_line: 1, end_line: 1, quote: "root cause" }],
      () => fileText,
    );
    expect(out.verified[0]!.start_line).toBe(2);
  });

  test("when chunk ranges are supplied, full-search relocation stays inside the chunk", () => {
    const text = ["needle", ...Array.from({ length: 48 }, () => "noise"), "needle"].join("\n");
    const out = verifyCitations(
      [{ file: "log.txt", start_line: 1, end_line: 1, quote: "needle" }],
      () => text,
      new Map([["log.txt", [{ startLine: 50, endLine: 50 }]]]),
    );
    expect(out.verified).toEqual([{ file: "log.txt", start_line: 50, end_line: 50, quote: "needle" }]);
  });

  test("drops hallucinated quotes", () => {
    const out = verifyCitations(
      [{ file: "log.txt", start_line: 1, end_line: 1, quote: "not actually present" }],
      () => fileText,
    );
    expect(out.verified).toHaveLength(0);
    expect(out.dropped).toHaveLength(1);
  });
});

describe("mergeDigests", () => {
  test("dedupes citations and carries not_found only when every part says so", () => {
    const citation = { file: "a", start_line: 1, end_line: 1, quote: "x" };
    const merged = mergeDigests([
      { answer: "one", not_found: false, citations: [citation], omitted: [], citations_dropped: 1 },
      { answer: "two", not_found: true, citations: [citation], omitted: ["small"], citations_dropped: 2 },
    ]);
    expect(merged.not_found).toBe(false);
    expect(merged.citations).toHaveLength(1);
    expect(merged.citations_dropped).toBe(3);
    expect(merged.answer).toContain("chunk 1");
  });

  test("does not leak chunk prefix for a single digest", () => {
    const merged = mergeDigests([
      { answer: "plain answer", not_found: false, citations: [], omitted: [], citations_dropped: 0 },
    ]);
    expect(merged.answer).toBe("plain answer");
  });
});

describe("distill orchestration", () => {
  function digest(d: Partial<Digest>): string {
    return JSON.stringify({ answer: "", not_found: false, citations: [], omitted: [], citations_dropped: 0, ...d });
  }

  test("verifies model citations and counts dropped hallucinations", async () => {
    const result = await distill(
      {
        query: "what failed?",
        inputs: [{ file: "log.txt", text: "root cause: missing export\nnoise" }],
        numCtx: 4096,
        budget: 500,
      },
      {
        estimator,
        complete: async () => ({
          text: digest({
            answer: "Missing export.",
            citations: [
              { file: "log.txt", start_line: 1, end_line: 1, quote: "root cause" },
              { file: "log.txt", start_line: 2, end_line: 2, quote: "fake quote" },
            ],
          }),
          promptTokens: 100,
          evalTokens: 20,
        }),
      },
    );
    expect(result.digest.citations).toHaveLength(1);
    expect(result.digest.citations_dropped).toBe(1);
    expect(result.digest.omitted).toEqual([]);
    expect(result.digest.input_kind).toBe("files");
    expect(result.digest.metrics).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 20,
    });
    expect(result.digest.metrics.output_tokens).toBeGreaterThan(0);
    expect(result.promptTokens).toBe(100);
    expect(result.evalTokens).toBe(20);
  });

  test("flags a non-not_found answer that has no verified citations", async () => {
    const result = await distill(
      {
        query: "what failed?",
        inputs: [{ file: "log.txt", text: "only noise" }],
        numCtx: 4096,
        budget: 500,
      },
      {
        estimator,
        complete: async () => ({
          text: digest({
            answer: "Unsupported assertion.",
            citations: [{ file: "log.txt", start_line: 1, end_line: 1, quote: "fake quote" }],
          }),
        }),
      },
    );
    expect(result.digest.citations).toHaveLength(0);
    expect(result.digest.citations_dropped).toBe(1);
    expect(result.digest.omitted.join("\n")).toContain("without any verified citations");
    expect(result.digest.omitted.filter((note) => note.includes("without any verified citations"))).toHaveLength(1);
  });

  test("carries oversized single-line truncation into the final digest", async () => {
    const result = await distill(
      {
        query: "where is the needle?",
        inputs: [{ file: "huge.log", text: `needle ${"x".repeat(1_000)}` }],
        numCtx: 1_000,
        budget: 50,
      },
      {
        estimator: (text) => text.length,
        complete: async (messages) => {
          expect(messages.reduce((sum, message) => sum + message.content.length, 0) + 50).toBeLessThanOrEqual(1_000);
          return {
            text: digest({
              answer: "Needle found.",
              citations: [{ file: "huge.log", start_line: 1, end_line: 1, quote: "needle" }],
            }),
          };
        },
      },
    );
    expect(result.chunks[0]!.estimatedTokens).toBeLessThanOrEqual(1_000);
    expect(result.digest.citations[0]!.quote).toBe("needle");
    expect(result.digest.omitted.join("\n")).toContain("single line exceeded");
  });

  test("retries once after malformed JSON", async () => {
    let calls = 0;
    const result = await distill(
      {
        query: "where?",
        inputs: [{ file: "a.txt", text: "needle here" }],
        numCtx: 4096,
        budget: 500,
      },
      {
        estimator,
        complete: async () => {
          calls++;
          return calls === 1
            ? { text: "not json", promptTokens: 10, evalTokens: 1 }
            : {
                text: digest({
                  answer: "Needle found.",
                  citations: [{ file: "a.txt", start_line: 1, end_line: 1, quote: "needle" }],
                }),
                promptTokens: 20,
                evalTokens: 2,
              };
        },
      },
    );
    expect(calls).toBe(2);
    expect(result.digest.citations).toHaveLength(1);
    expect(result.promptTokens).toBe(30);
    expect(result.evalTokens).toBe(3);
  });

  test("preserves map-verified citations when reduce returns none", async () => {
    let calls = 0;
    const result = await distill(
      {
        query: "needles?",
        inputs: [
          { file: "a.txt", text: `needle-a ${"a".repeat(250)}` },
          { file: "b.txt", text: `needle-b ${"b".repeat(250)}` },
        ],
        numCtx: 900,
        budget: 50,
      },
      {
        estimator: (text) => text.length,
        complete: async () => {
          calls++;
          if (calls === 1) {
            return {
              text: digest({
                answer: "A",
                citations: [{ file: "a.txt", start_line: 1, end_line: 1, quote: "needle-a" }],
              }),
            };
          }
          if (calls === 2) {
            return {
              text: digest({
                answer: "B",
                citations: [{ file: "b.txt", start_line: 1, end_line: 1, quote: "needle-b" }],
              }),
            };
          }
          return { text: digest({ answer: "A and B", citations: [] }) };
        },
      },
    );
    expect(calls).toBe(3);
    expect(result.digest.citations.map((c) => c.quote).sort()).toEqual(["needle-a", "needle-b"]);
    expect(result.digest.omitted.join("\n")).not.toContain("without any verified citations");
  });

  test("truncates only partial answers before reduce and preserves citations", async () => {
    const seenPrompts: string[] = [];
    let calls = 0;
    const result = await distill(
      {
        query: "needles?",
        inputs: [
          { file: "a.txt", text: `needle-a\n${"a".repeat(280)}` },
          { file: "b.txt", text: `needle-b\n${"b".repeat(280)}` },
        ],
        numCtx: 1_100,
        budget: 50,
      },
      {
        estimator: (text) => text.length,
        complete: async (messages) => {
          calls++;
          seenPrompts.push(messages.map((m) => m.content).join("\n"));
          if (calls === 1) {
            return {
              text: digest({
                answer: "A".repeat(500),
                citations: [{ file: "a.txt", start_line: 1, end_line: 1, quote: "needle-a" }],
              }),
              promptTokens: 10,
            };
          }
          if (calls === 2) {
            return {
              text: digest({
                answer: "B".repeat(500),
                citations: [{ file: "b.txt", start_line: 1, end_line: 1, quote: "needle-b" }],
              }),
              promptTokens: 10,
            };
          }
          return { text: digest({ answer: "combined" }), promptTokens: 10 };
        },
      },
    );
    expect(calls).toBe(3);
    // join() adds one display-only separator between the two messages.
    expect(seenPrompts[2]!.length - 1 + 50).toBeLessThanOrEqual(1_100);
    expect(seenPrompts[2]).toContain("partial answers were truncated");
    expect(seenPrompts[2]).toContain("needle-a");
    expect(seenPrompts[2]).toContain("needle-b");
    expect(result.digest.citations.map((c) => c.quote).sort()).toEqual(["needle-a", "needle-b"]);
    expect(result.digest.omitted.join("\n")).toContain("partial answers were truncated");
    expect(result.promptTokens).toBe(30);
  });

  test("rejects num_ctx when reduce citations cannot fit", async () => {
    let calls = 0;
    await expect(
      distill(
        {
          query: "needles?",
          inputs: [
            { file: "a.txt", text: `needle-a ${"a".repeat(140)}` },
            { file: "b.txt", text: `needle-b ${"b".repeat(140)}` },
          ],
          numCtx: 650,
          budget: 50,
        },
        {
          estimator: (text) => text.length,
          complete: async () => {
            calls++;
            const file = calls === 1 ? "a.txt" : "b.txt";
            const quote = calls === 1 ? "needle-a" : "needle-b";
            return {
              text: digest({
                answer: "x".repeat(300),
                citations: Array.from({ length: 8 }, (_, i) => ({
                  file,
                  start_line: 1,
                  end_line: 1,
                  quote: `${quote} ${"q".repeat(i)}`,
                })),
              }),
            };
          },
        },
      ),
    ).rejects.toBeInstanceOf(DistillConfigError);
  });

  test("rejects a response budget that leaves no room for a map chunk", async () => {
    await expect(
      distill(
        { query: "x", inputs: [{ file: "a", text: "x" }], numCtx: 300, budget: 250 },
        { estimator: (text) => text.length, complete: async () => ({ text: digest({}) }) },
      ),
    ).rejects.toBeInstanceOf(DistillConfigError);
  });
});

describe("cmdDistill", () => {
  let tmpHome: string;
  let cwd: string;
  const origLog = console.log;
  const origErr = process.stderr.write;
  let logs: string[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-distill-home-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "localrig-distill-cwd-"));
    process.env.LH_HOME = tmpHome;
    logs = [];
    console.log = (msg?: unknown) => {
      logs.push(String(msg ?? ""));
    };
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    console.log = origLog;
    process.stderr.write = origErr;
    delete process.env.LH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function completeWithDigest(text: string) {
    return async (_messages: ChatMessage[], options: ChatRequestOptions) => {
      expect(options.format).toBeDefined();
      return { text, promptTokens: 12, evalTokens: 3 };
    };
  }

  test("reads a file, saves a distill session, and exposes JSON-safe result data", async () => {
    fs.writeFileSync(path.join(cwd, "log.txt"), "root cause: bad import\nsecondary failure\n");
    const rc = await cmdDistill(
      ["-q", "root?", "log.txt", "--cwd", cwd, "--json", "--quiet", "--session-id", "distill-sid"],
      {
        readStdin: async () => "",
        complete: completeWithDigest(
          JSON.stringify({
            answer: "Bad import.",
            not_found: false,
            citations: [{ file: "log.txt", start_line: 1, end_line: 1, quote: "bad import" }],
            omitted: [],
          }),
        ),
      },
    );
    expect(rc).toBe(0);
    const rec = loadSession("distill-sid")!;
    expect(rec.kind).toBe("distill");
    expect(rec.prompt).toBe("root?");
    expect(rec.tokens).toEqual({ prompt: 12, completion: 3 });
    expect(JSON.parse(rec.result).citations[0].file).toBe("log.txt");
  });

  test("includes warnings in JSON output even when quiet", async () => {
    fs.writeFileSync(path.join(cwd, "bin.dat"), Buffer.from([1, 0, 2]));
    const rc = await cmdDistill(["-q", "needle?", "bin.dat", "--cwd", cwd, "--json", "--quiet", "--session-id", "warn-sid"], {
      readStdin: async () => "needle from stdin",
      complete: completeWithDigest(
        JSON.stringify({
          answer: "Needle.",
          not_found: false,
          citations: [{ file: "(stdin)", start_line: 1, end_line: 1, quote: "needle" }],
          omitted: [],
        }),
      ),
    });
    expect(rc).toBe(0);
    const out = JSON.parse(logs.at(-1)!);
    expect(out.warnings[0]).toContain("skipped binary file");
  });

  test("includes warnings in JSON config errors when every file is skipped", async () => {
    fs.writeFileSync(path.join(cwd, "bin.dat"), Buffer.from([1, 0, 2]));
    const rc = await cmdDistill(["-q", "needle?", "bin.dat", "--cwd", cwd, "--json", "--quiet"], {
      readStdin: async () => "",
      complete: completeWithDigest("{}"),
    });
    expect(rc).toBe(1);
    const out = JSON.parse(logs.at(-1)!);
    expect(out.error_kind).toBe("config");
    expect(out.warnings[0]).toContain("skipped binary file");
  });

  test("uses stdin when no files are provided", async () => {
    const rc = await cmdDistill(["-q", "needle?", "--cwd", cwd, "--json", "--quiet", "--session-id", "stdin-sid"], {
      readStdin: async () => "needle from pipe",
      complete: completeWithDigest(
        JSON.stringify({
          answer: "Needle from pipe.",
          not_found: false,
          citations: [{ file: "(stdin)", start_line: 1, end_line: 1, quote: "needle" }],
          omitted: [],
        }),
      ),
    });
    expect(rc).toBe(0);
    expect(JSON.parse(loadSession("stdin-sid")!.result).citations[0].file).toBe("(stdin)");
  });

  test("rejects fractional budgets that floor to zero", async () => {
    const rc = await cmdDistill(["-q", "x", "--budget", "0.5", "--json", "--session-id", "budget-sid"], {
      readStdin: async () => "x",
      complete: completeWithDigest("{}"),
    });
    expect(rc).toBe(1);
    expect(loadSession("budget-sid")).toBeNull();
  });

  test("invalid model JSON after repair is an ollama_error, not config", async () => {
    const rc = await cmdDistill(["-q", "x", "--json", "--quiet", "--session-id", "model-error-sid"], {
      readStdin: async () => "x",
      complete: async () => ({ text: "not json", promptTokens: 9, evalTokens: 1 }),
    });
    expect(rc).toBe(1);
    const rec = loadSession("model-error-sid")!;
    expect(rec.errorKind).toBe("ollama_error");
    expect(JSON.parse(logs.at(-1)!).error_kind).toBe("ollama_error");
  });

  test("rejects missing query before saving a session", async () => {
    const rc = await cmdDistill(["--json", "--session-id", "bad-sid"], {
      readStdin: async () => "x",
      complete: completeWithDigest("{}"),
    });
    expect(rc).toBe(1);
    expect(loadSession("bad-sid")).toBeNull();
  });
});

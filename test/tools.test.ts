import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig, type Config } from "../src/config.ts";
import type { ToolContext, ToolDef } from "../src/types.ts";
import { createScoutTools, createTools, renderTodos } from "../src/tools/registry.ts";
import { globToRegExp } from "../src/tools/glob.ts";
import { manualGrep } from "../src/tools/grep.ts";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tools-test-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(cwd: string): ToolContext {
  return { cwd, readFiles: new Map(), todos: [], signal: new AbortController().signal };
}

function makeTools(cwd: string, overrides: Partial<Config> = {}): { tools: Map<string, ToolDef>; ctx: ToolContext } {
  const config: Config = { ...defaultConfig, ...overrides };
  const ctx = makeCtx(cwd);
  const tools = new Map(createTools(config, ctx).map((t) => [t.name, t]));
  return { tools, ctx };
}

function makeScoutTools(cwd: string, overrides: Partial<Config> = {}): { tools: Map<string, ToolDef>; ctx: ToolContext } {
  const config: Config = { ...defaultConfig, ...overrides };
  const ctx = makeCtx(cwd);
  const tools = new Map(createScoutTools(config, ctx).map((t) => [t.name, t]));
  return { tools, ctx };
}

function subdir(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------------------------------------------------------------------------
// glob pattern translation
// ---------------------------------------------------------------------------

describe("globToRegExp", () => {
  test("**/*.ts crosses directories and matches top level", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/deep/nested/a.ts")).toBe(true);
    expect(re.test("a.js")).toBe(false);
    expect(re.test("src/a.tsx")).toBe(false);
  });

  test("* does not cross directory boundaries", () => {
    const re = globToRegExp("src/*.json");
    expect(re.test("src/a.json")).toBe(true);
    expect(re.test("src/sub/a.json")).toBe(false);
    expect(re.test("a.json")).toBe(false);
  });

  test("{a,b} alternation", () => {
    const re = globToRegExp("*.{ts,tsx}");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("a.tsx")).toBe(true);
    expect(re.test("a.js")).toBe(false);
  });

  test("? matches exactly one non-slash char", () => {
    const re = globToRegExp("a?.ts");
    expect(re.test("ab.ts")).toBe(true);
    expect(re.test("a.ts")).toBe(false);
    expect(re.test("a/b.ts")).toBe(false);
  });

  test("[abc] character class", () => {
    const re = globToRegExp("file[12].txt");
    expect(re.test("file1.txt")).toBe(true);
    expect(re.test("file2.txt")).toBe(true);
    expect(re.test("file3.txt")).toBe(false);
  });

  test("dots are literal", () => {
    const re = globToRegExp("a.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("axts")).toBe(false);
  });
});

describe("glob tool", () => {
  test("finds files and returns relative paths", async () => {
    const dir = subdir("globtool");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "x");
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "x");
    fs.writeFileSync(path.join(dir, "c.js"), "x");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("glob")!.execute({ pattern: "**/*.ts" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("src/a.ts");
    expect(res.output).toContain("src/b.ts");
    expect(res.output).not.toContain("c.js");
  });

  test("no matches is ok:true", async () => {
    const dir = subdir("globtool-empty");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("glob")!.execute({ pattern: "**/*.zig" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("no files match");
  });

  test("allows absolute paths within cwd", async () => {
    const dir = subdir("globtool-absolute-inside");
    fs.writeFileSync(path.join(dir, "inside.ts"), "x");
    const { tools, ctx } = makeScoutTools(dir);
    const res = await tools.get("glob")!.execute({ pattern: "*.ts", path: dir }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("inside.ts");
  });

  test("rejects relative, absolute, and symlink escapes from cwd", async () => {
    const dir = subdir("globtool-boundary");
    const outside = subdir("globtool-boundary-outside");
    fs.writeFileSync(path.join(outside, "secret.ts"), "secret");
    fs.symlinkSync(outside, path.join(dir, "outside-link"));
    const { tools, ctx } = makeScoutTools(dir);
    for (const escapedPath of ["../globtool-boundary-outside", outside, "outside-link"]) {
      const res = await tools.get("glob")!.execute({ pattern: "**/*", path: escapedPath }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toContain("outside the working directory");
      expect(res.output).not.toContain("secret.ts");
    }
  });
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe("read tool", () => {
  test("numbers lines cat -n style", async () => {
    const dir = subdir("read1");
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "alpha\nbeta\ngamma\n");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("read")!.execute({ path: "f.txt" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("1\talpha\n2\tbeta\n3\tgamma");
    expect(res.filePath).toBe(fs.realpathSync(file));
    expect(ctx.readFiles.has(fs.realpathSync(file))).toBe(true);
  });

  test("offset and limit select a window with a continue note", async () => {
    const dir = subdir("read2");
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    fs.writeFileSync(path.join(dir, "f.txt"), lines.join("\n") + "\n");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("read")!.execute({ path: "f.txt", offset: 3, limit: 2 }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("3\tline3");
    expect(res.output).toContain("4\tline4");
    expect(res.output).not.toContain("line5");
    expect(res.output).toContain("[Showing lines 3–4 of 10. Use offset=5 to continue.]");
  });

  test("caps at readMaxLines with continue note", async () => {
    const dir = subdir("read3");
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    fs.writeFileSync(path.join(dir, "f.txt"), lines.join("\n"));
    const { tools, ctx } = makeTools(dir, { readMaxLines: 5 });
    const res = await tools.get("read")!.execute({ path: "f.txt" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("5\tl5");
    expect(res.output).not.toContain("l6\n");
    expect(res.output).toContain("[Showing lines 1–5 of 20. Use offset=6 to continue.]");
  });

  test("truncates long lines", async () => {
    const dir = subdir("read4");
    fs.writeFileSync(path.join(dir, "f.txt"), "short\n" + "x".repeat(500) + "\n");
    const { tools, ctx } = makeTools(dir, { readMaxLineChars: 50 });
    const res = await tools.get("read")!.execute({ path: "f.txt" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("… [line truncated]");
    expect(res.output).not.toContain("x".repeat(51));
  });

  test("missing file suggests glob", async () => {
    const dir = subdir("read5");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("read")!.execute({ path: "nope.txt" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("glob");
  });

  test("directory is refused with glob hint", async () => {
    const dir = subdir("read6");
    fs.mkdirSync(path.join(dir, "sub"));
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("read")!.execute({ path: "sub" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("directory");
  });

  test("binary file is refused", async () => {
    const dir = subdir("read7");
    fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0, 4, 5]));
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("read")!.execute({ path: "bin.dat" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("binary");
  });

  test("allows absolute paths within cwd", async () => {
    const dir = subdir("read-absolute-inside");
    const file = path.join(dir, "inside.txt");
    fs.writeFileSync(file, "inside\n");
    const { tools, ctx } = makeScoutTools(dir);
    const res = await tools.get("read")!.execute({ path: file }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("inside");
  });

  test("rejects relative, absolute, and symlink escapes from cwd", async () => {
    const dir = subdir("read-boundary");
    const outside = path.join(tmp, "read-boundary-secret.txt");
    fs.writeFileSync(outside, "secret\n");
    fs.symlinkSync(outside, path.join(dir, "secret-link.txt"));
    const { tools, ctx } = makeScoutTools(dir);
    for (const escapedPath of ["../read-boundary-secret.txt", outside, "secret-link.txt"]) {
      const res = await tools.get("read")!.execute({ path: escapedPath }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toContain("outside the working directory");
      expect(res.output).not.toContain("secret\n");
    }
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe("write tool", () => {
  test("records created and modified files when report tracking is enabled", async () => {
    const dir = subdir("write-report");
    fs.writeFileSync(path.join(dir, "existing.txt"), "old");
    const { tools, ctx } = makeTools(dir);
    ctx.report = { changedFiles: new Map(), commandsRun: [] };
    await tools.get("write")!.execute({ path: "new.txt", content: "new" }, ctx);
    await tools.get("write")!.execute({ path: "existing.txt", content: "newer" }, ctx);
    expect([...ctx.report.changedFiles.entries()]).toEqual([
      ["new.txt", "created"],
      ["existing.txt", "modified"],
    ]);
  });

  test("creates parent dirs and reports line count", async () => {
    const dir = subdir("write1");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("write")!.execute({ path: "a/b/c.txt", content: "one\ntwo\n" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("wrote 2 lines to");
    expect(fs.readFileSync(path.join(dir, "a/b/c.txt"), "utf8")).toBe("one\ntwo\n");
    expect(ctx.readFiles.has(fs.realpathSync(path.join(dir, "a/b/c.txt")))).toBe(true);
  });

  test("warns when overwriting a never-read file", async () => {
    const dir = subdir("write2");
    fs.writeFileSync(path.join(dir, "f.txt"), "old");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("write")!.execute({ path: "f.txt", content: "new" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("[warning] overwrote existing file that was never read");
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("new");
  });

  test("identical content is a no-op that never touches disk", async () => {
    const dir = subdir("write-identical");
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "same\ncontent\n");
    const before = fs.statSync(file).mtimeMs;
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("write")!.execute({ path: "f.txt", content: "same\ncontent\n" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("No change: file already contains exactly this content.");
    expect(fs.statSync(file).mtimeMs).toBe(before); // untouched
  });

  test("rejects full rewrite of an existing 30+ line file without overwrite", async () => {
    const dir = subdir("write-guard");
    const orig = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const file = path.join(dir, "big.ts");
    fs.writeFileSync(file, orig);
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("write")!.execute({ path: "big.ts", content: "export const x = 1;\n" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("already exists (40 lines)");
    expect(res.output).toContain("Use edit for targeted changes");
    expect(res.output).toContain("overwrite: true");
    // File must be untouched by the rejected write.
    expect(fs.readFileSync(file, "utf8")).toBe(orig);
  });

  test("rejects at exactly the 30-line boundary", async () => {
    const dir = subdir("write-guard-boundary");
    const orig = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const file = path.join(dir, "b.ts");
    fs.writeFileSync(file, orig);
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("write")!.execute({ path: "b.ts", content: "x\n" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("already exists (30 lines)");
    expect(fs.readFileSync(file, "utf8")).toBe(orig);
  });

  test("accepts full rewrite of a 30+ line file with overwrite: true", async () => {
    const dir = subdir("write-guard-ok");
    const orig = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const file = path.join(dir, "big.ts");
    fs.writeFileSync(file, orig);
    const { tools, ctx } = makeTools(dir);
    const res = await tools
      .get("write")!
      .execute({ path: "big.ts", content: "export const x = 1;\n", overwrite: true }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("wrote 1 lines to");
    expect(fs.readFileSync(file, "utf8")).toBe("export const x = 1;\n");
  });

  test("rewrites an existing under-30-line file freely (no overwrite needed)", async () => {
    const dir = subdir("write-small");
    const file = path.join(dir, "small.ts");
    fs.writeFileSync(file, Array.from({ length: 29 }, (_, i) => `l${i}`).join("\n") + "\n");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("write")!.execute({ path: "small.ts", content: "one line\n" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("wrote 1 lines to");
    expect(fs.readFileSync(file, "utf8")).toBe("one line\n");
  });

  test("new file is unaffected by the guardrail (large content is fine)", async () => {
    const dir = subdir("write-new-big");
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("write")!.execute({ path: "brand-new.ts", content: big }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("wrote 100 lines to");
    expect(fs.readFileSync(path.join(dir, "brand-new.ts"), "utf8")).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// edit — cascade behavior
// ---------------------------------------------------------------------------

async function setupEdit(name: string, content: string) {
  const dir = subdir(name);
  const file = path.join(dir, "f.ts");
  fs.writeFileSync(file, content);
  const { tools, ctx } = makeTools(dir);
  await tools.get("read")!.execute({ path: "f.ts" }, ctx); // register the read
  return { dir, file, edit: tools.get("edit")!, ctx };
}

describe("edit tool", () => {
  test("records modified files when report tracking is enabled", async () => {
    const { edit, ctx } = await setupEdit("edit-report", "const x = 1;\n");
    ctx.report = { changedFiles: new Map(), commandsRun: [] };
    const res = await edit.execute({ path: "f.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, ctx);
    expect(res.ok).toBe(true);
    expect([...ctx.report.changedFiles.entries()]).toEqual([["f.ts", "modified"]]);
  });

  test("keeps created action when editing a file created earlier in the run", async () => {
    const { edit, ctx } = await setupEdit("edit-report-created", "const x = 1;\n");
    ctx.report = { changedFiles: new Map([["f.ts", "created"]]), commandsRun: [] };
    const res = await edit.execute({ path: "f.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, ctx);
    expect(res.ok).toBe(true);
    expect([...ctx.report.changedFiles.entries()]).toEqual([["f.ts", "created"]]);
  });

  test("requires the file to be read first", async () => {
    const dir = subdir("edit-noread");
    fs.writeFileSync(path.join(dir, "f.ts"), "const x = 1;\n");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("edit")!.execute({ path: "f.ts", old_string: "x = 1", new_string: "x = 2" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("Read the file first with the read tool");
  });

  test("exact single match succeeds with a diff snippet", async () => {
    const { file, edit, ctx } = await setupEdit("edit-exact", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const res = await edit.execute({ path: "f.ts", old_string: "const b = 2;", new_string: "const b = 20;" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("- const b = 2;");
    expect(res.output).toContain("+ const b = 20;");
    expect(res.output).toContain("replaced 1 occurrence(s)");
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
  });

  test("0 matches yields closest-line hint and line-number warning", async () => {
    const { edit, ctx } = await setupEdit("edit-nomatch", "function greetUser(name) {\n  return 'hi ' + name;\n}\n");
    const res = await edit.execute(
      { path: "f.ts", old_string: "function greetUser(username) {", new_string: "function welcomeUser(username) {" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain("No exact match");
    expect(res.output).toContain("Closest line in file (line 1)");
    expect(res.output).toContain("function greetUser(name) {");
    expect(res.output).toContain("line numbers from read output must not be included");
  });

  test("multiple matches without replace_all lists line numbers", async () => {
    const { edit, ctx } = await setupEdit("edit-multi", "let v = 0;\nlet v = 0;\nconsole.log(v);\n");
    const res = await edit.execute({ path: "f.ts", old_string: "let v = 0;", new_string: "let v = 1;" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("matches 2 places");
    expect(res.output).toContain("lines 1, 2");
    expect(res.output).toContain("replace_all");
  });

  test("replace_all replaces every occurrence", async () => {
    const { file, edit, ctx } = await setupEdit("edit-all", "a=1\nb=1\na=1\n");
    const res = await edit.execute({ path: "f.ts", old_string: "a=1", new_string: "a=9", replace_all: true }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("replaced 2 occurrence(s)");
    expect(fs.readFileSync(file, "utf8")).toBe("a=9\nb=1\na=9\n");
  });

  test("normalized matcher: smart quotes and trailing whitespace", async () => {
    const { file, edit, ctx } = await setupEdit("edit-norm", 'const msg = "hello";   \nconst n = 1;\n');
    // old_string uses smart quotes and lacks trailing whitespace
    const res = await edit.execute(
      { path: "f.ts", old_string: "const msg = “hello”;", new_string: 'const msg = "bye";' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe('const msg = "bye";\nconst n = 1;\n');
  });

  test("line-trimmed matcher: indentation drift", async () => {
    const { file, edit, ctx } = await setupEdit("edit-trim", "function f() {\n    return 1;\n}\n");
    // old_string has wrong indentation on the middle line
    const res = await edit.execute(
      { path: "f.ts", old_string: "function f() {\n  return 1;\n}", new_string: "function f() {\n    return 2;\n}" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("function f() {\n    return 2;\n}\n");
  });

  test("escape-normalized matcher: literal \\n in old_string", async () => {
    const { file, edit, ctx } = await setupEdit("edit-escape", "const a = 1;\nconst b = 2;\n");
    const res = await edit.execute(
      { path: "f.ts", old_string: "const a = 1;\\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 1;\nconst b = 3;\n");
  });

  test("block-anchor matcher: first/last lines anchor a drifted middle", async () => {
    const content = "function big() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
    const { file, edit, ctx } = await setupEdit("edit-anchor", content);
    // Middle lines differ (model hallucinated slightly) but first/last match.
    const res = await edit.execute(
      {
        path: "f.ts",
        old_string: "function big() {\n  const a = 1;\n  const b = 99;\n  return a + b;\n}",
        new_string: "function big() {\n  return 3;\n}",
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("function big() {\n  return 3;\n}\n");
  });

  test("ambiguity falls through to the next matcher", async () => {
    // Exact matcher finds substring "foo" three times -> ambiguous; the
    // normalized whole-line matcher finds exactly one line equal to "foo".
    const content = "foo\n foo\nbar foo\n";
    const { file, edit, ctx } = await setupEdit("edit-fallthrough", content);
    const res = await edit.execute({ path: "f.ts", old_string: "foo", new_string: "baz" }, ctx);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("baz\n foo\nbar foo\n");
  });

  test(">3x span guard refuses oversized fuzzy matches", async () => {
    // 5-line block (within ±25% of the 4-line old_string) whose middle lines
    // are far longer than old_string — block-anchor matches, guard refuses.
    const content = "start()\n" + "  filler_line_with_lots_of_characters_here();\n".repeat(3) + "end()\n";
    const { file, edit, ctx } = await setupEdit("edit-guard", content);
    const res = await edit.execute(
      { path: "f.ts", old_string: "start()\nzz\nyy\nend()", new_string: "gone()" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain("matched span much larger than old_string");
    expect(fs.readFileSync(file, "utf8")).toBe(content); // untouched
  });

  test("no-op replacement is refused", async () => {
    const { edit, ctx } = await setupEdit("edit-noop", "aaa\nbbb\n");
    // Exact matcher misses; line-trimmed matches "bbb" but replacement equals
    // the original line, so content is unchanged.
    const res = await edit.execute({ path: "f.ts", old_string: "bbb ", new_string: "bbb", replace_all: false }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("No changes made: replacement produced identical content.");
  });

  test("CRLF file: matches LF old_string and preserves CRLF endings", async () => {
    const { file, edit, ctx } = await setupEdit("edit-crlf", "one\r\ntwo\r\nthree\r\n");
    const res = await edit.execute({ path: "f.ts", old_string: "two", new_string: "TWO" }, ctx);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
  });
});

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

describe("bash tool", () => {
  test("records commands when report tracking is enabled", async () => {
    const dir = subdir("bash-report");
    const { tools, ctx } = makeTools(dir);
    ctx.report = { changedFiles: new Map(), commandsRun: [] };
    const res = await tools.get("bash")!.execute({ command: "echo hello" }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.report.commandsRun).toEqual(["echo hello"]);
  });

  test("captures output and succeeds", async () => {
    const dir = subdir("bash1");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("bash")!.execute({ command: "echo hello" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hello");
  });

  test("nonzero exit appends exit code and fails", async () => {
    const dir = subdir("bash2");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("bash")!.execute({ command: "exit 3" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("[exit code 3]");
  });

  test("empty output becomes (no output)", async () => {
    const dir = subdir("bash3");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("bash")!.execute({ command: "true" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("(no output)");
  });

  test("truncation keeps head and tail with actionable marker", async () => {
    const dir = subdir("bash4");
    const { tools, ctx } = makeTools(dir, { bashMaxChars: 300 });
    const res = await tools.get("bash")!.execute(
      { command: 'i=1; while [ $i -le 200 ]; do echo "row_$i"; i=$((i+1)); done' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("row_1"); // head survives
    expect(res.output).toContain("row_200"); // tail survives
    expect(res.output).toContain("chars truncated");
    expect(res.output.length).toBeLessThan(600); // 300 + marker + exit note headroom
    // spool file mentioned and exists
    const m = /full output saved to (\S+\.log)/.exec(res.output);
    expect(m).not.toBeNull();
    expect(fs.existsSync(m![1]!)).toBe(true);
    const full = fs.readFileSync(m![1]!, "utf8");
    expect(full).toContain("row_100");
    fs.rmSync(m![1]!, { force: true });
  });

  test("runs in ctx.cwd", async () => {
    const dir = subdir("bash5");
    fs.writeFileSync(path.join(dir, "marker.txt"), "x");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("bash")!.execute({ command: "ls" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("marker.txt");
  });

  test("timeout kills the command", async () => {
    const dir = subdir("bash6");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("bash")!.execute({ command: "sleep 5", timeout_ms: 200 }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("timed out");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// grep (manual fallback path — hermetic, no rg needed)
// ---------------------------------------------------------------------------

describe("manualGrep fallback", () => {
  test("finds matches as relpath:line: text", async () => {
    const dir = subdir("grep1");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "const one = 1;\nfunction target() {}\n");
    fs.writeFileSync(path.join(dir, "src", "b.js"), "target here too\n");
    const matches = await manualGrep(/target/, dir, dir, undefined, 100);
    expect(matches).toContain("src/a.ts:2: function target() {}");
    expect(matches).toContain("src/b.js:1: target here too");
  });

  test("glob filter narrows files", async () => {
    const dir = subdir("grep2");
    fs.writeFileSync(path.join(dir, "a.ts"), "needle\n");
    fs.writeFileSync(path.join(dir, "b.js"), "needle\n");
    const matches = await manualGrep(/needle/, dir, dir, "*.ts", 100);
    expect(matches.length).toBe(1);
    expect(matches[0]).toContain("a.ts:1:");
  });

  test("caps matches at the limit", async () => {
    const dir = subdir("grep3");
    fs.writeFileSync(path.join(dir, "f.txt"), Array.from({ length: 50 }, () => "hit").join("\n"));
    const matches = await manualGrep(/hit/, dir, dir, undefined, 10);
    expect(matches.length).toBe(10);
  });

  test("skips node_modules and binary files", async () => {
    const dir = subdir("grep4");
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "x.ts"), "secret\n");
    fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0x73, 0, 0x63]));
    fs.writeFileSync(path.join(dir, "ok.ts"), "secret\n");
    const matches = await manualGrep(/secret/, dir, dir, undefined, 100);
    expect(matches.length).toBe(1);
    expect(matches[0]).toContain("ok.ts");
  });
});

describe("grep tool", () => {
  test("no matches is ok:true", async () => {
    const dir = subdir("grep5");
    fs.writeFileSync(path.join(dir, "a.txt"), "nothing here\n");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("grep")!.execute({ pattern: "zzz_not_present_zzz" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("no matches found");
  });

  test("invalid regex is an actionable error", async () => {
    const dir = subdir("grep6");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("grep")!.execute({ pattern: "([unclosed" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("Invalid regex");
  });

  test("allows absolute paths within cwd", async () => {
    const dir = subdir("grep-absolute-inside");
    fs.writeFileSync(path.join(dir, "inside.txt"), "needle\n");
    const { tools, ctx } = makeScoutTools(dir);
    const res = await tools.get("grep")!.execute({ pattern: "needle", path: dir }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("inside.txt:1: needle");
  });

  test("rejects relative, absolute, and symlink escapes from cwd", async () => {
    const dir = subdir("grep-boundary");
    const outside = subdir("grep-boundary-outside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "needle secret\n");
    fs.symlinkSync(outside, path.join(dir, "outside-link"));
    const { tools, ctx } = makeScoutTools(dir);
    for (const escapedPath of ["../grep-boundary-outside", outside, "outside-link"]) {
      const res = await tools.get("grep")!.execute({ pattern: "needle", path: escapedPath }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toContain("outside the working directory");
      expect(res.output).not.toContain("needle secret");
    }
  });
});

// ---------------------------------------------------------------------------
// todo + renderTodos
// ---------------------------------------------------------------------------

describe("renderTodos", () => {
  test("formats each status", () => {
    const out = renderTodos([
      { id: 1, content: "done item", status: "completed" },
      { id: 2, content: "in-progress item", status: "in_progress" },
      { id: 3, content: "pending item", status: "pending" },
    ]);
    expect(out).toBe("[x] done item\n[>] in-progress item\n[ ] pending item");
  });

  test("empty list renders empty string", () => {
    expect(renderTodos([])).toBe("");
  });
});

describe("todo tool", () => {
  test("replaces ctx.todos in place and renders", async () => {
    const dir = subdir("todo1");
    const { tools, ctx } = makeTools(dir);
    const todosRef = ctx.todos; // same array object must be mutated
    const res = await tools.get("todo")!.execute(
      {
        items: [
          { content: "first", status: "completed" },
          { content: "second", status: "in_progress" },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("[x] first\n[>] second");
    expect(ctx.todos).toBe(todosRef);
    expect(ctx.todos.length).toBe(2);
    expect(ctx.todos[0]).toEqual({ id: 1, content: "first", status: "completed" });

    // second call fully replaces
    const res2 = await tools.get("todo")!.execute({ items: [{ content: "only", status: "pending" }] }, ctx);
    expect(res2.ok).toBe(true);
    expect(ctx.todos.length).toBe(1);
    expect(ctx.todos[0]!.content).toBe("only");
  });

  test("rejects bad status with allowed values", async () => {
    const dir = subdir("todo2");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("todo")!.execute({ items: [{ content: "x", status: "doing" }] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('"pending", "in_progress" or "completed"');
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe("createTools", () => {
  test("exposes all seven tools with schemas", () => {
    const dir = subdir("registry1");
    const { tools } = makeTools(dir);
    expect([...tools.keys()].sort()).toEqual(["bash", "edit", "glob", "grep", "read", "todo", "write"]);
    for (const t of tools.values()) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters.type).toBe("object");
      expect(Array.isArray(t.parameters.required)).toBe(true);
    }
  });

  test("normal coding tools reject cwd escapes too", async () => {
    const dir = subdir("registry-normal-scope");
    const outside = path.join(tmp, "registry-normal-scope.txt");
    fs.writeFileSync(outside, "outside context\n");
    const { tools, ctx } = makeTools(dir);
    const res = await tools.get("read")!.execute({ path: outside }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("outside the working directory");
  });
});

describe("createScoutTools", () => {
  test("exposes only read-only exploration tools", () => {
    const dir = subdir("registry-scout");
    const config: Config = { ...defaultConfig };
    const ctx = makeCtx(dir);
    const tools = createScoutTools(config, ctx);
    expect(tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read"]);
    expect(tools.every((t) => t.mutating === false)).toBe(true);
  });
});

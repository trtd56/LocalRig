import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Config } from "../config.ts";
import type { ToolDef, ToolResult } from "../types.ts";

export function createEditTool(_config: Config): ToolDef {
  return {
    name: "edit",
    mutating: true,
    description:
      "Replace an exact text snippet in a file. Args: path (required), old_string (required, exact existing text), " +
      "new_string (required), replace_all (optional bool, default false). " +
      'Example: {"path": "src/a.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}. ' +
      "You must read the file first. Copy old_string exactly from the file — do NOT include the line numbers shown by read.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the working directory" },
        old_string: { type: "string", description: "Exact text to replace (copied verbatim from the file, no line numbers)" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default: false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(args, ctx): Promise<ToolResult> {
      try {
        const p = args.path;
        if (typeof p !== "string" || p.length === 0) {
          return { ok: false, output: 'Missing "path". Call edit like: {"path": "src/a.ts", "old_string": "...", "new_string": "..."}' };
        }
        const oldStr = args.old_string;
        const newStr = args.new_string;
        if (typeof oldStr !== "string" || typeof newStr !== "string") {
          return {
            ok: false,
            output:
              '"old_string" and "new_string" must both be strings. Example: {"path": "src/a.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}',
          };
        }
        if (oldStr.length === 0) {
          return { ok: false, output: "old_string is empty. To create or fully rewrite a file, use the write tool instead." };
        }
        if (oldStr === newStr) {
          return { ok: false, output: "old_string and new_string are identical — nothing would change. Make new_string different." };
        }
        const replaceAll = args.replace_all === true;
        const abs = path.resolve(ctx.cwd, p);
        const rel = relPath(ctx.cwd, abs);

        let raw: string;
        try {
          raw = await fs.readFile(abs, "utf8");
        } catch {
          return { ok: false, output: `File not found: ${abs}. To create a new file use the write tool; to locate an existing one use glob.` };
        }
        if (!ctx.readFiles.has(abs)) {
          return { ok: false, output: "Read the file first with the read tool, then retry the edit." };
        }

        const hadBom = raw.startsWith("\uFEFF");
        const content = hadBom ? raw.slice(1) : raw;

        const found = findWithCascade(content, oldStr, replaceAll);
        if (found.kind === "multi") {
          return {
            ok: false,
            output:
              `old_string matches ${found.lines.length} places in ${abs} (lines ${found.lines.join(", ")}). ` +
              "Include more surrounding lines in old_string to make it unique, or set replace_all=true to replace every occurrence.",
          };
        }
        if (found.kind === "none") {
          const closest = closestLine(content, oldStr);
          const closestPart = closest
            ? `Closest line in file (line ${closest.line}): ${closest.text.trim().slice(0, 200)}\n`
            : "";
          return {
            ok: false,
            output:
              `No exact match for old_string in ${abs}.\n` +
              closestPart +
              "Common cause: line numbers from read output must not be included in old_string. " +
              "Re-read the file and copy the text exactly (whitespace matters), then retry.",
          };
        }

        // Guard: a fuzzy matcher grabbing a span much larger than old_string is
        // almost certainly wrong — refuse rather than mangle the file.
        if (found.matcher !== "exact") {
          for (const s of found.spans) {
            if (s.end - s.start > 3 * oldStr.length) {
              return {
                ok: false,
                output: "matched span much larger than old_string — re-read the file and retry with exact text",
              };
            }
          }
        }

        // Line-based matchers matched despite EOL/whitespace drift, so restore
        // the file's dominant line endings inside the replacement text too.
        const insert = found.lineBased ? withFileEol(content, newStr) : newStr;
        let newContent = content;
        for (const s of [...found.spans].sort((a, b) => b.start - a.start)) {
          newContent = newContent.slice(0, s.start) + insert + newContent.slice(s.end);
        }
        if (newContent === content) {
          return { ok: false, output: "No changes made: replacement produced identical content." };
        }

        const first = found.spans.reduce((a, b) => (a.start <= b.start ? a : b));
        const snippet = buildDiffSnippet(content, first.start, first.end, insert);
        await fs.writeFile(abs, hadBom ? "\uFEFF" + newContent : newContent, "utf8");
        ctx.readFiles.set(abs, Date.now());

        const replaced = found.spans.length;
        const output = snippet + "\n" + `edited ${abs}: replaced ${replaced} occurrence(s)`;
        return { ok: true, output, display: `edited ${rel} (${replaced} occurrence${replaced === 1 ? "" : "s"})` };
      } catch (err) {
        return { ok: false, output: `edit failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Matcher cascade
//
// Ordered from strictest to loosest; each matcher is accepted only when it
// yields exactly one match (or >=1 with replace_all, where safe). Ambiguous
// results fall through to the next matcher; if nothing ever matched uniquely
// the first ambiguous result becomes the multi-match error.
// ---------------------------------------------------------------------------

export interface Span {
  start: number;
  end: number;
}

type CascadeResult =
  | { kind: "ok"; spans: Span[]; matcher: string; lineBased: boolean }
  | { kind: "multi"; lines: number[] }
  | { kind: "none" };

export function findWithCascade(content: string, oldStr: string, replaceAll: boolean): CascadeResult {
  const { spans: lineSpans, texts } = splitWithSpans(content);
  const unescaped = unescapeString(oldStr);

  const matchers: { name: string; lineBased: boolean; uniqueOnly: boolean; run: () => Span[] }[] = [
    { name: "exact", lineBased: false, uniqueOnly: false, run: () => exactSpans(content, oldStr) },
    {
      name: "normalized",
      lineBased: true,
      uniqueOnly: false,
      run: () => lineMatcherSpans(texts, lineSpans, oldStr, normalizeLine),
    },
    {
      name: "line-trimmed",
      lineBased: true,
      uniqueOnly: false,
      run: () => lineMatcherSpans(texts, lineSpans, oldStr, (s) => normalizeLine(s).trim()),
    },
    {
      name: "escape-exact",
      lineBased: false,
      uniqueOnly: false,
      run: () => (unescaped === oldStr ? [] : exactSpans(content, unescaped)),
    },
    {
      name: "escape-trimmed",
      lineBased: true,
      uniqueOnly: false,
      run: () => (unescaped === oldStr ? [] : lineMatcherSpans(texts, lineSpans, unescaped, (s) => normalizeLine(s).trim())),
    },
    // Candidate blocks may overlap, so never replace-all with this one.
    { name: "block-anchor", lineBased: true, uniqueOnly: true, run: () => blockAnchorSpans(texts, lineSpans, oldStr) },
  ];

  let firstAmbiguous: number[] | null = null;
  for (const m of matchers) {
    let spans: Span[];
    try {
      spans = m.run();
    } catch {
      continue;
    }
    if (spans.length === 0) continue;
    if (spans.length === 1 || (replaceAll && !m.uniqueOnly)) {
      return { kind: "ok", spans, matcher: m.name, lineBased: m.lineBased };
    }
    if (firstAmbiguous === null) {
      firstAmbiguous = spans.map((s) => lineNumberAt(content, s.start));
    }
  }
  if (firstAmbiguous !== null) return { kind: "multi", lines: firstAmbiguous };
  return { kind: "none" };
}

function exactSpans(content: string, needle: string): Span[] {
  const out: Span[] = [];
  let i = content.indexOf(needle);
  while (i !== -1) {
    out.push({ start: i, end: i + needle.length });
    i = content.indexOf(needle, i + needle.length);
  }
  return out;
}

/**
 * Match old_string against consecutive whole file lines, comparing each line
 * through `norm`. Returns spans over the ORIGINAL content (excluding the
 * final line's EOL), so unchanged bytes stay untouched.
 */
function lineMatcherSpans(
  texts: string[],
  lineSpans: LineSpan[],
  oldStr: string,
  norm: (s: string) => string,
): Span[] {
  const oldLines = splitOldLines(oldStr);
  const normOld = oldLines.map(norm);
  if (normOld.every((l) => l === "")) return []; // nothing to anchor on
  const normFile = texts.map(norm);
  const out: Span[] = [];
  outer: for (let i = 0; i + normOld.length <= normFile.length; i++) {
    for (let j = 0; j < normOld.length; j++) {
      if (normFile[i + j] !== normOld[j]) continue outer;
    }
    out.push({ start: lineSpans[i]!.start, end: lineSpans[i + normOld.length - 1]!.end });
    i += normOld.length - 1; // non-overlapping
  }
  return out;
}

/**
 * Anchor on first + last line (trimmed) when old_string has >= 3 lines.
 * A candidate block's size must be within ±25% of old_string's line count.
 */
function blockAnchorSpans(texts: string[], lineSpans: LineSpan[], oldStr: string): Span[] {
  const oldLines = splitOldLines(oldStr);
  if (oldLines.length < 3) return [];
  const first = oldLines[0]!.trim();
  const last = oldLines[oldLines.length - 1]!.trim();
  if (first === "" || last === "") return [];
  const minSize = Math.max(2, Math.ceil(oldLines.length * 0.75));
  const maxSize = Math.floor(oldLines.length * 1.25);
  const trimmed = texts.map((t) => t.trim());
  const out: Span[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== first) continue;
    for (let size = minSize; size <= maxSize; size++) {
      const j = i + size - 1;
      if (j >= trimmed.length) break;
      if (j > i && trimmed[j] === last) {
        out.push({ start: lineSpans[i]!.start, end: lineSpans[j]!.end });
      }
    }
  }
  return out;
}

/** Split old_string into lines, dropping BOM and one trailing empty line. */
function splitOldLines(oldStr: string): string[] {
  const lines = oldStr.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Turn literal two-char escapes the model sometimes emits into real chars. */
export function unescapeString(s: string): string {
  const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\" };
  return s.replace(/\\(n|t|r|"|'|\\)/g, (_, c: string) => map[c]!);
}

/** Normalize one line (no EOL) for fuzzy comparison. */
export function normalizeLine(s: string): string {
  let t = s.normalize("NFKC");
  t = t.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'"); // smart single quotes
  t = t.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"'); // smart double quotes
  t = t.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-"); // unicode dashes
  t = t.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " "); // NBSP/thin/ideographic spaces
  return t.replace(/\s+$/, ""); // trailing whitespace
}

interface LineSpan {
  /** Index of the first char of the line in the content. */
  start: number;
  /** Index just past the last char of the line text (before \r\n or \n). */
  end: number;
}

/** Split content into lines, recording original char spans (excluding EOLs). */
function splitWithSpans(content: string): { spans: LineSpan[]; texts: string[] } {
  const spans: LineSpan[] = [];
  const texts: string[] = [];
  let pos = 0;
  for (;;) {
    const nl = content.indexOf("\n", pos);
    if (nl === -1) {
      spans.push({ start: pos, end: content.length });
      texts.push(content.slice(pos));
      break;
    }
    const end = nl > pos && content[nl - 1] === "\r" ? nl - 1 : nl;
    spans.push({ start: pos, end });
    texts.push(content.slice(pos, end));
    pos = nl + 1;
  }
  return { spans, texts };
}

/** Rewrite the replacement's line endings to the file's dominant EOL. */
function withFileEol(content: string, replacement: string): string {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length;
  const eol = crlf > lf - crlf ? "\r\n" : "\n";
  return replacement.replace(/\r?\n/g, eol);
}

function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Error-help: closest line by token overlap
// ---------------------------------------------------------------------------

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 0),
  );
}

export function closestLine(content: string, oldStr: string): { line: number; text: string } | null {
  const firstOldLine = (oldStr.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
  if (firstOldLine === "") return null;
  const targetTokens = tokenize(firstOldLine);
  const lines = content.split("\n");
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let score = 0;
    for (const t of tokenize(line)) if (targetTokens.has(t)) score++;
    if (line.includes(firstOldLine) || (firstOldLine.length > 8 && firstOldLine.includes(line.trim()))) score += 100;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;
  return { line: bestIdx + 1, text: lines[bestIdx]! };
}

// ---------------------------------------------------------------------------
// Mini unified-diff snippet around the change
// ---------------------------------------------------------------------------

const MAX_SNIPPET_LINES = 12;

function buildDiffSnippet(content: string, spliceStart: number, spliceEnd: number, insert: string): string {
  // Expand the splice region to whole lines of the original content.
  const lineStart = content.lastIndexOf("\n", spliceStart - 1) + 1;
  let lineEnd = content.indexOf("\n", Math.max(spliceEnd, spliceStart));
  if (lineEnd === -1) lineEnd = content.length;
  if (lineEnd > 0 && content[lineEnd - 1] === "\r") lineEnd -= 1;

  const oldBlock = content.slice(lineStart, lineEnd);
  const newBlock = content.slice(lineStart, spliceStart) + insert + content.slice(spliceEnd, lineEnd);
  const startLineNo = lineNumberAt(content, lineStart);

  const allLines = content.split("\n");
  const ctxBefore = allLines.slice(Math.max(0, startLineNo - 3), startLineNo - 1).map((l) => "  " + trimCr(l));
  const oldCount = oldBlock.split("\n").length;
  const afterIdx = startLineNo - 1 + oldCount;
  const ctxAfter = allLines.slice(afterIdx, afterIdx + 2).map((l) => "  " + trimCr(l));

  const parts: string[] = [`@@ line ${startLineNo} @@`];
  parts.push(...ctxBefore);
  for (const l of oldBlock.split("\n")) parts.push("- " + trimCr(l));
  for (const l of newBlock.split("\n")) parts.push("+ " + trimCr(l));
  parts.push(...ctxAfter);

  if (parts.length > MAX_SNIPPET_LINES) {
    return parts.slice(0, MAX_SNIPPET_LINES - 1).join("\n") + "\n… [diff truncated]";
  }
  return parts.join("\n");
}

function trimCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function relPath(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  if (r === "") return ".";
  return r.startsWith("..") ? abs : r;
}

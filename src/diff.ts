import { createHash } from "node:crypto";
import {
  distill,
  DistillConfigError,
  type Citation,
  type CitationRange,
  type DistillChunk,
  type DistillDeps,
  type VerifiedCitations,
  verifyCitations,
} from "./distill.ts";
import { type PreprocessResult, toPreprocessResult } from "./preprocess.ts";

export type DiffLineKind = "context" | "added" | "deleted";
export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffLine {
  snapshot_line: number;
  kind: DiffLineKind;
  text: string;
  old_line: number | null;
  new_line: number | null;
}

export interface DiffHunk {
  index: number;
  header: string;
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
  lines: DiffLine[];
}

export interface DiffFile {
  old_path: string | null;
  new_path: string | null;
  path: string;
  status: DiffFileStatus;
  hunks: DiffHunk[];
}

export interface DiffSnapshot {
  text: string;
  sha256: string;
  files: DiffFile[];
}

/** Legacy citation fields stay present; location is always relative to the immutable diff snapshot. */
export interface DiffCitation extends Citation {
  path: string;
  old_path: string | null;
  new_path: string | null;
  hunk: number;
  hunk_header: string;
  snapshot_line: number;
  line_type: DiffLineKind;
  old_line: number | null;
  new_line: number | null;
  snapshot_sha256: string;
}

export interface DiffRequest {
  query: string;
  text: string;
  numCtx: number;
  budget: number;
  think?: boolean;
}

export interface DiffResult {
  digest: PreprocessResult<DiffCitation>;
  snapshot: DiffSnapshot;
  promptTokens: number;
  evalTokens: number;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\x0b",
    f: "\f",
    r: "\r",
    "\\": "\\",
    '"': '"',
  };
  const appendText = (text: string) => bytes.push(...encoder.encode(text));
  for (let i = 0; i < value.length;) {
    const point = value.codePointAt(i)!;
    const char = String.fromCodePoint(point);
    i += char.length;
    if (char !== "\\") {
      appendText(char);
      continue;
    }
    const next = value[i];
    if (next === undefined) {
      appendText("\\");
      break;
    }
    if (/[0-7]/.test(next)) {
      let octal = "";
      while (octal.length < 3 && i < value.length && /[0-7]/.test(value[i]!)) octal += value[i++]!;
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    i++;
    appendText(escapes[next] ?? next);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return trimmed;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeGitQuotedPath(trimmed.slice(1, -1));
  }
  return trimmed.split("\t", 1)[0]!;
}

function stripPrefix(value: string): string | null {
  const path = unquoteGitPath(value);
  if (path === "/dev/null") return null;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function readQuotedToken(text: string, offset: number): { value: string; end: number } | null {
  if (text[offset] !== '"') return null;
  let escaped = false;
  for (let i = offset + 1; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"' && !escaped) {
      return { value: decodeGitQuotedPath(text.slice(offset + 1, i)), end: i + 1 };
    }
    if (char === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return null;
}

/** Split `diff --git` without treating spaces inside a path as separators. */
function provisionalPath(header: string): { oldPath: string | null; newPath: string | null } {
  const prefix = "diff --git ";
  if (!header.startsWith(prefix)) return { oldPath: null, newPath: null };
  const body = header.slice(prefix.length);
  if (body.startsWith('"')) {
    const oldToken = readQuotedToken(body, 0);
    if (!oldToken) return { oldPath: null, newPath: null };
    const secondStart = oldToken.end + 1;
    const newToken = readQuotedToken(body, secondStart);
    const oldValue = oldToken.value;
    const newValue = newToken ? newToken.value : body.slice(secondStart);
    return { oldPath: stripPrefix(oldValue), newPath: stripPrefix(newValue) };
  }

  const candidates: Array<{ oldValue: string; newValue: string }> = [];
  for (let i = body.indexOf(" b/"); i >= 0; i = body.indexOf(" b/", i + 1)) {
    const oldValue = body.slice(0, i);
    const newValue = body.slice(i + 1);
    if (oldValue.startsWith("a/") && newValue.startsWith("b/")) candidates.push({ oldValue, newValue });
  }
  const selected = candidates.find(({ oldValue, newValue }) => oldValue.slice(2) === newValue.slice(2)) ?? candidates[0];
  if (!selected) return { oldPath: null, newPath: null };
  return { oldPath: stripPrefix(selected.oldValue), newPath: stripPrefix(selected.newValue) };
}

export function parseUnifiedDiff(text: string): DiffSnapshot {
  if (!text.trim()) throw new DistillConfigError("diff input is empty");
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = splitLines(normalized);
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let recognized = false;
  let sawGitHeader = false;

  const addFile = (oldPath: string | null, newPath: string | null): DiffFile => {
    const next: DiffFile = {
      old_path: oldPath,
      new_path: newPath,
      path: newPath ?? oldPath ?? "(unknown)",
      status: oldPath === null ? "added" : newPath === null ? "deleted" : "modified",
      hunks: [],
    };
    files.push(next);
    return next;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const snapshotLine = i + 1;
    if (raw.startsWith("diff --git ")) {
      recognized = true;
      sawGitHeader = true;
      const paths = provisionalPath(raw);
      file = addFile(paths.oldPath, paths.newPath);
      hunk = undefined;
      continue;
    }
    const hunkOldUsed = hunk ? oldLine - hunk.old_start : 0;
    const hunkNewUsed = hunk ? newLine - hunk.new_start : 0;
    const hunkNeedsLines = hunk !== undefined && (hunkOldUsed < hunk.old_count || hunkNewUsed < hunk.new_count);
    if (hunkNeedsLines && (raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-"))) {
      const prefix = raw[0]!;
      const kind: DiffLineKind = prefix === "+" ? "added" : prefix === "-" ? "deleted" : "context";
      const line: DiffLine = {
        snapshot_line: snapshotLine,
        kind,
        text: raw.slice(1),
        old_line: kind === "added" ? null : oldLine,
        new_line: kind === "deleted" ? null : newLine,
      };
      hunk!.lines.push(line);
      if (kind !== "added") oldLine++;
      if (kind !== "deleted") newLine++;
      continue;
    }
    if (
      hunk &&
      !hunkNeedsLines &&
      (raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-")) &&
      !raw.startsWith("--- ") &&
      !raw.startsWith("+++ ")
    ) {
      throw new DistillConfigError(`invalid unified diff: extra line after declared hunk counts at line ${snapshotLine}`);
    }
    if (raw.startsWith("--- ")) {
      recognized = true;
      if (!file || file.hunks.length > 0) file = addFile(null, null);
      file.old_path = stripPrefix(raw.slice(4));
      file.path = file.new_path ?? file.old_path ?? "(unknown)";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (!file) throw new DistillConfigError(`invalid unified diff: +++ header without file at line ${snapshotLine}`);
      file.new_path = stripPrefix(raw.slice(4));
      file.path = file.new_path ?? file.old_path ?? "(unknown)";
      file.status = file.old_path === null ? "added" : file.new_path === null ? "deleted" : "modified";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      if (!file) throw new DistillConfigError(`invalid unified diff: rename metadata without file at line ${snapshotLine}`);
      file.old_path = unquoteGitPath(raw.slice("rename from ".length));
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("rename to ")) {
      if (!file) throw new DistillConfigError(`invalid unified diff: rename metadata without file at line ${snapshotLine}`);
      file.new_path = unquoteGitPath(raw.slice("rename to ".length));
      file.path = file.new_path;
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("@@")) {
      if (!file) throw new DistillConfigError(`invalid unified diff: hunk without file at line ${snapshotLine}`);
      const match = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) throw new DistillConfigError(`invalid unified diff hunk header at line ${snapshotLine}`);
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        index: file.hunks.length + 1,
        header: raw,
        old_start: oldLine,
        old_count: match[2] === undefined ? 1 : Number(match[2]),
        new_start: newLine,
        new_count: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && raw === "\\ No newline at end of file") continue;
    // Any other line ends a non-git plain unified hunk. Git metadata between
    // hunks remains attached to the current file.
    if (hunk && raw.length > 0 && !raw.startsWith("index ")) hunk = undefined;
  }

  if (!recognized || files.length === 0) {
    throw new DistillConfigError("input is not a unified git diff");
  }
  if (!sawGitHeader && files.every((candidate) => candidate.hunks.length === 0)) {
    throw new DistillConfigError("invalid unified diff: no hunks");
  }
  for (const f of files) {
    if (f.path === "(unknown)") throw new DistillConfigError("invalid unified diff: missing file path");
    for (const candidate of f.hunks) {
      const oldCount = candidate.lines.filter((line) => line.kind !== "added").length;
      const newCount = candidate.lines.filter((line) => line.kind !== "deleted").length;
      if (oldCount !== candidate.old_count || newCount !== candidate.new_count) {
        throw new DistillConfigError(`invalid unified diff: hunk line counts do not match ${candidate.header}`);
      }
    }
  }
  return {
    text: normalized,
    sha256: createHash("sha256").update(normalized).digest("hex"),
    files,
  };
}

function locateDiffLine(snapshot: DiffSnapshot, citation: Citation): { file: DiffFile; hunk: DiffHunk; line: DiffLine } | null {
  // distill already verified quote presence and repaired snapshot line drift.
  // Resolve only inside the cited immutable snapshot range, including deleted lines.
  for (const file of snapshot.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.snapshot_line < citation.start_line || line.snapshot_line > citation.end_line) continue;
        const raw = `${line.kind === "added" ? "+" : line.kind === "deleted" ? "-" : " "}${line.text}`;
        if (raw.includes(citation.quote) || line.text.includes(citation.quote)) return { file, hunk, line };
      }
    }
  }
  return null;
}

export function verifyDiffCitations(
  snapshot: DiffSnapshot,
  citations: Citation[],
): { verified: DiffCitation[]; dropped: Citation[] } {
  const verified: DiffCitation[] = [];
  const dropped: Citation[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    const found = locateDiffLine(snapshot, citation);
    if (!found) {
      dropped.push(citation);
      continue;
    }
    const { file, hunk, line } = found;
    const out: DiffCitation = {
      // Keep the legacy keys, but line numbers refer to the diff snapshot. This
      // is the only stable source for deletions; semantic positions are below.
      file: file.path,
      start_line: line.snapshot_line,
      end_line: line.snapshot_line,
      quote: citation.quote,
      path: file.path,
      old_path: file.old_path,
      new_path: file.new_path,
      hunk: hunk.index,
      hunk_header: hunk.header,
      snapshot_line: line.snapshot_line,
      line_type: line.kind,
      old_line: line.old_line,
      new_line: line.new_line,
      snapshot_sha256: snapshot.sha256,
    };
    const key = `${out.snapshot_line}\0${out.quote}`;
    if (!seen.has(key)) {
      seen.add(key);
      verified.push(out);
    }
  }
  return { verified, dropped };
}

function hunkRanges(file: DiffFile): CitationRange[] {
  return file.hunks.flatMap((hunk) => {
    const first = hunk.lines[0];
    const last = hunk.lines.at(-1);
    return first && last ? [{ startLine: first.snapshot_line, endLine: last.snapshot_line }] : [];
  });
}

function intersectRanges(left: CitationRange[], right: CitationRange[]): CitationRange[] {
  const out: CitationRange[] = [];
  for (const a of left) {
    for (const b of right) {
      const startLine = Math.max(a.startLine, b.startLine);
      const endLine = Math.min(a.endLine, b.endLine);
      if (startLine <= endLine) out.push({ startLine, endLine });
    }
  }
  return out;
}

/** Verify model citations against only the named file's hunks in the immutable
 * snapshot. This accepts both natural repository paths and the legacy single
 * source label while preventing quote relocation across files. */
function verifyDiffSourceCitations(
  snapshot: DiffSnapshot,
  citations: Citation[],
  chunk?: DistillChunk,
): VerifiedCitations {
  const filesByLabel = new Map<string, DiffFile[]>();
  const addLabel = (label: string | null, file: DiffFile) => {
    if (!label) return;
    const current = filesByLabel.get(label) ?? [];
    if (!current.includes(file)) current.push(file);
    filesByLabel.set(label, current);
  };
  for (const file of snapshot.files) {
    addLabel(file.path, file);
    addLabel(file.old_path, file);
    addLabel(file.new_path, file);
    if (file.old_path) addLabel(`a/${file.old_path}`, file);
    if (file.new_path) addLabel(`b/${file.new_path}`, file);
  }

  const chunkRanges = chunk
    ? chunk.sources
      .filter((source) => source.file === "(diff snapshot)")
      .map((source) => ({ startLine: source.startLine, endLine: source.endLine }))
    : undefined;
  const verified: Citation[] = [];
  const dropped: Citation[] = [];
  for (const citation of citations) {
    const targetFiles = citation.file === "(diff snapshot)"
      ? snapshot.files
      : filesByLabel.get(citation.file) ?? [];
    let ranges = targetFiles.flatMap(hunkRanges);
    if (chunkRanges) ranges = intersectRanges(ranges, chunkRanges);
    if (ranges.length === 0) {
      dropped.push(citation);
      continue;
    }
    const checked = verifyCitations(
      [citation],
      () => snapshot.text,
      new Map([[citation.file, ranges]]),
    );
    verified.push(...checked.verified);
    dropped.push(...checked.dropped);
  }
  return { verified, dropped };
}

export async function preprocessDiff(request: DiffRequest, deps: DistillDeps): Promise<DiffResult> {
  const snapshot = parseUnifiedDiff(request.text);
  const result = await distill(
    {
      query:
        `${request.query}\n\nAnalyze the unified git diff snapshot. ` +
        "Support claims with exact quotes from changed or context lines; deleted lines are valid evidence. " +
        "Do not cite file contents outside this snapshot.",
      inputs: [{ file: "(diff snapshot)", text: snapshot.text }],
      numCtx: request.numCtx,
      budget: request.budget,
      think: request.think,
    },
    {
      ...deps,
      verifyCitations: (citations, chunk) => verifyDiffSourceCitations(snapshot, citations, chunk),
    },
  );
  const checked = verifyDiffCitations(snapshot, result.digest.citations);
  const omitted = [...result.digest.omitted];
  if (!result.digest.not_found && result.digest.answer.trim() && checked.verified.length === 0) {
    const note = "model returned an answer without citations to changed/context lines in the verified diff snapshot";
    if (!omitted.includes(note)) omitted.push(note);
  }
  const digest = toPreprocessResult(
    {
      answer: result.digest.answer,
      not_found: result.digest.not_found,
      citations: checked.verified,
      omitted,
      citations_dropped: result.digest.citations_dropped + checked.dropped.length,
    },
    "diff",
    {
      inputTokens: deps.estimator(snapshot.text),
      outputTokens: deps.estimator(JSON.stringify({
        answer: result.digest.answer,
        not_found: result.digest.not_found,
        citations: checked.verified,
        omitted,
        citations_dropped: result.digest.citations_dropped + checked.dropped.length,
      })),
      promptTokens: result.promptTokens,
      completionTokens: result.evalTokens,
    },
  );
  return { digest, snapshot, promptTokens: result.promptTokens, evalTokens: result.evalTokens };
}

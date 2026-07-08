import type { ChatMessage, ChatRequestOptions } from "./types.ts";

export interface DistillInput {
  file: string;
  text: string;
}

export interface DistillSource {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface DistillChunk {
  index: number;
  sources: DistillSource[];
  text: string;
  estimatedTokens: number;
}

export interface Citation {
  file: string;
  start_line: number;
  end_line: number;
  quote: string;
}

export interface Digest {
  answer: string;
  not_found: boolean;
  citations: Citation[];
  omitted: string[];
  citations_dropped: number;
}

export interface ParseDigestResult {
  ok: boolean;
  digest?: Digest;
  error?: string;
}

export interface VerifiedCitations {
  verified: Citation[];
  dropped: Citation[];
}

export interface CitationRange {
  startLine: number;
  endLine: number;
}

export interface DistillCompleteResult {
  text: string;
  promptTokens?: number;
  evalTokens?: number;
}

export interface DistillDeps {
  complete: (messages: ChatMessage[], options: ChatRequestOptions) => Promise<DistillCompleteResult>;
  estimator: (text: string) => number;
}

export interface DistillRequest {
  query: string;
  inputs: DistillInput[];
  numCtx: number;
  budget: number;
  think?: boolean;
}

export interface DistillResult {
  digest: Digest;
  chunks: DistillChunk[];
  promptTokens: number;
  evalTokens: number;
}

const SYSTEM_PROMPT =
  "You extract only information relevant to the user's query from provided text. " +
  "Return JSON only. Every factual claim should be supported by citations. " +
  "A citation quote must be exact text from the cited file, preferably from the first cited line. " +
  "Line numbers in citations must use the original file line numbers shown in each chunk header, not chunk-relative line numbers. " +
  "If the answer is not present, set not_found true and keep citations empty. Do not invent evidence.";

export const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    not_found: { type: "boolean" },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
          quote: { type: "string" },
        },
        required: ["file", "start_line", "end_line", "quote"],
      },
    },
    omitted: { type: "array", items: { type: "string" } },
    citations_dropped: { type: "number" },
  },
  required: ["answer", "not_found", "citations", "omitted"],
};

export class DistillConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistillConfigError";
  }
}

export class DistillModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistillModelError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sourceBlock(source: DistillSource): string {
  return `--- ${source.file}:${source.startLine}-${source.endLine} ---\n${source.text}`;
}

function chunkText(sources: DistillSource[]): string {
  return sources.map(sourceBlock).join("\n\n");
}

export function planChunks(
  inputs: DistillInput[],
  tokenBudget: number,
  estimator: (text: string) => number,
): DistillChunk[] {
  if (tokenBudget < 50) throw new DistillConfigError("chunk token budget must be at least 50");
  const chunks: DistillChunk[] = [];
  let current: DistillSource[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = chunkText(current);
    chunks.push({ index: chunks.length, sources: current, text, estimatedTokens: estimator(text) });
    current = [];
  };

  const pushSource = (source: DistillSource) => {
    const candidate = [...current, source];
    if (current.length > 0 && estimator(chunkText(candidate)) > tokenBudget) flush();
    current.push(source);
  };

  for (const input of inputs) {
    const lines = splitLines(input.text);
    const full: DistillSource = {
      file: input.file,
      startLine: 1,
      endLine: Math.max(1, lines.length),
      text: input.text,
    };
    if (estimator(sourceBlock(full)) <= tokenBudget) {
      pushSource(full);
      continue;
    }

    flush();
    let start = 0;
    while (start < lines.length || (lines.length === 0 && start === 0)) {
      let end = Math.min(lines.length, start + 1);
      let lastGoodEnd = end;
      while (end <= lines.length) {
        const partText = lines.slice(start, end).join("\n");
        const source: DistillSource = {
          file: input.file,
          startLine: start + 1,
          endLine: Math.max(start + 1, end),
          text: partText,
        };
        if (estimator(sourceBlock(source)) > tokenBudget) break;
        lastGoodEnd = end;
        end++;
      }
      if (lastGoodEnd === start) {
        const line = lines[start] ?? "";
        const source: DistillSource = {
          file: input.file,
          startLine: start + 1,
          endLine: start + 1,
          text: line,
        };
        chunks.push({
          index: chunks.length,
          sources: [source],
          text: sourceBlock(source),
          estimatedTokens: estimator(sourceBlock(source)),
        });
        start++;
      } else {
        const source: DistillSource = {
          file: input.file,
          startLine: start + 1,
          endLine: Math.max(start + 1, lastGoodEnd),
          text: lines.slice(start, lastGoodEnd).join("\n"),
        };
        chunks.push({
          index: chunks.length,
          sources: [source],
          text: sourceBlock(source),
          estimatedTokens: estimator(sourceBlock(source)),
        });
        start = lastGoodEnd;
      }
      if (lines.length === 0) break;
    }
  }
  flush();
  return chunks;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) return fenced[1]!.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function normalizeCitation(raw: unknown, index: number): Citation {
  if (!isRecord(raw)) throw new Error(`citations[${index}] must be an object`);
  const file = raw.file;
  const start = raw.start_line;
  const end = raw.end_line;
  const quote = raw.quote;
  if (typeof file !== "string" || file.trim() === "") throw new Error(`citations[${index}].file must be a string`);
  if (typeof quote !== "string" || quote.trim() === "") throw new Error(`citations[${index}].quote must be a string`);
  if (typeof start !== "number" || !Number.isFinite(start)) throw new Error(`citations[${index}].start_line must be a number`);
  if (typeof end !== "number" || !Number.isFinite(end)) throw new Error(`citations[${index}].end_line must be a number`);
  const startLine = Math.max(1, Math.floor(start));
  const endLine = Math.max(startLine, Math.floor(end));
  return { file, start_line: startLine, end_line: endLine, quote };
}

export function parseDigest(text: string): ParseDigestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    if (!isRecord(parsed)) throw new Error("digest must be an object");
    if (typeof parsed.answer !== "string") throw new Error("answer must be a string");
    if (typeof parsed.not_found !== "boolean") throw new Error("not_found must be a boolean");
    if (!Array.isArray(parsed.citations)) throw new Error("citations must be an array");
    if (!Array.isArray(parsed.omitted)) throw new Error("omitted must be an array");
    const omitted = parsed.omitted.map((v, i) => {
      if (typeof v !== "string") throw new Error(`omitted[${i}] must be a string`);
      return v;
    });
    const citations = parsed.citations.map(normalizeCitation);
    const dropped =
      typeof parsed.citations_dropped === "number" && Number.isFinite(parsed.citations_dropped)
        ? Math.max(0, Math.floor(parsed.citations_dropped))
        : 0;
    return {
      ok: true,
      digest: {
        answer: parsed.answer,
        not_found: parsed.not_found,
        citations,
        omitted,
        citations_dropped: dropped,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function findQuoteCitation(lines: string[], citation: Citation, fromLine: number, toLine: number): Citation | null {
  const from = Math.max(0, fromLine - 1);
  const to = Math.min(lines.length, toLine);
  const quoteLines = citation.quote.split("\n");
  if (quoteLines.length === 1) {
    for (let i = from; i < to; i++) {
      if (lines[i]!.includes(citation.quote)) {
        return { ...citation, start_line: i + 1, end_line: i + 1 };
      }
    }
    return null;
  }
  for (let i = from; i < to; i++) {
    const candidate = lines.slice(i, i + quoteLines.length).join("\n");
    if (candidate.includes(citation.quote)) {
      return { ...citation, start_line: i + 1, end_line: Math.min(lines.length, i + quoteLines.length) };
    }
  }
  return null;
}

function relocateCitation(lines: string[], citation: Citation, ranges?: CitationRange[]): Citation | null {
  const searchRanges = ranges && ranges.length > 0 ? ranges : [{ startLine: 1, endLine: lines.length }];
  const tryInRange = (range: CitationRange): Citation | null => {
    const exact = findQuoteCitation(
      lines,
      citation,
      Math.max(range.startLine, citation.start_line),
      Math.min(range.endLine, citation.end_line),
    );
    if (exact) return exact;

    const nearby = findQuoteCitation(
      lines,
      citation,
      Math.max(range.startLine, citation.start_line - 20),
      Math.min(range.endLine, citation.end_line + 20),
    );
    if (nearby) return nearby;

    return findQuoteCitation(lines, citation, range.startLine, range.endLine);
  };

  for (const range of searchRanges) {
    const fixed = tryInRange(range);
    if (fixed) return fixed;
  }
  return null;
}

export function verifyCitations(
  citations: Citation[],
  readFile: (file: string) => string,
  rangesByFile?: ReadonlyMap<string, CitationRange[]>,
): VerifiedCitations {
  const cache = new Map<string, string[] | null>();
  const verified: Citation[] = [];
  const dropped: Citation[] = [];

  const linesFor = (file: string): string[] | null => {
    if (cache.has(file)) return cache.get(file)!;
    try {
      const lines = splitLines(readFile(file));
      cache.set(file, lines);
      return lines;
    } catch {
      cache.set(file, null);
      return null;
    }
  };

  for (const citation of citations) {
    const lines = linesFor(citation.file);
    const fixed = lines ? relocateCitation(lines, citation, rangesByFile?.get(citation.file)) : null;
    if (fixed) verified.push(fixed);
    else dropped.push(citation);
  }
  return { verified: dedupeCitations(verified), dropped };
}

function citationKey(c: Citation): string {
  return `${c.file}\0${c.start_line}\0${c.end_line}\0${c.quote}`;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = citationKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function mergeDigests(parts: Digest[]): Digest {
  if (parts.length === 1) {
    return {
      ...parts[0]!,
      citations: dedupeCitations(parts[0]!.citations),
      omitted: [...parts[0]!.omitted],
    };
  }
  const citations = dedupeCitations(parts.flatMap((p) => p.citations));
  const omitted = parts.flatMap((p) => p.omitted);
  const answers = parts
    .map((p, i) => (p.answer.trim() ? `chunk ${i + 1}: ${p.answer.trim()}` : ""))
    .filter((s) => s.length > 0);
  return {
    answer: answers.join("\n").trim(),
    not_found: parts.length > 0 && parts.every((p) => p.not_found),
    citations,
    omitted,
    citations_dropped: parts.reduce((n, p) => n + p.citations_dropped, 0),
  };
}

function buildMapMessages(query: string, chunk: DistillChunk): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Query:\n${query}\n\n` +
        `Input chunk ${chunk.index + 1}:\n${chunk.text}\n\n` +
        "Return a digest JSON object for this chunk only.",
    },
  ];
}

function buildReduceMessages(query: string, digest: Digest): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Query:\n${query}\n\n` +
        "Partial verified digest data follows. Use only these citations; do not create new ones.\n" +
        JSON.stringify({ answer: digest.answer, not_found: digest.not_found, citations: digest.citations, omitted: digest.omitted }) +
        "\n\nReturn one concise final digest JSON object.",
    },
  ];
}

function rangesForChunk(chunk: DistillChunk): Map<string, CitationRange[]> {
  const ranges = new Map<string, CitationRange[]>();
  for (const source of chunk.sources) {
    const cur = ranges.get(source.file) ?? [];
    cur.push({ startLine: source.startLine, endLine: source.endLine });
    ranges.set(source.file, cur);
  }
  return ranges;
}

async function completeDigest(
  deps: DistillDeps,
  messages: ChatMessage[],
  options: ChatRequestOptions,
): Promise<{ digest: Digest; promptTokens: number; evalTokens: number }> {
  const first = await deps.complete(messages, options);
  let parsed = parseDigest(first.text);
  let promptTokens = first.promptTokens ?? 0;
  let evalTokens = first.evalTokens ?? 0;
  if (!parsed.ok) {
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: first.text },
      {
        role: "user",
        content:
          `The previous response did not match the required digest JSON schema: ${parsed.error}. ` +
          "Return only valid JSON with answer, not_found, citations, omitted, and citations_dropped.",
      },
    ];
    const repaired = await deps.complete(repairMessages, options);
    promptTokens = repaired.promptTokens ?? 0;
    evalTokens += repaired.evalTokens ?? 0;
    parsed = parseDigest(repaired.text);
  }
  if (!parsed.ok || !parsed.digest) throw new DistillModelError(`model returned invalid digest: ${parsed.error}`);
  return { digest: parsed.digest, promptTokens, evalTokens };
}

function contextChunkBudget(request: DistillRequest, deps: DistillDeps): number {
  const fixed = deps.estimator(SYSTEM_PROMPT) + deps.estimator(request.query) + request.budget + 500;
  return Math.max(200, request.numCtx - fixed);
}

export async function distill(request: DistillRequest, deps: DistillDeps): Promise<DistillResult> {
  if (!request.query.trim()) throw new DistillConfigError("distill requires -q/--query");
  if (request.inputs.length === 0) throw new DistillConfigError("distill requires at least one input file or stdin");
  const chunkBudget = contextChunkBudget(request, deps);
  const chunks = planChunks(request.inputs, chunkBudget, deps.estimator);
  if (chunks.length === 0) throw new DistillConfigError("distill found no readable input");

  const byFile = new Map(request.inputs.map((i) => [i.file, i.text]));
  const readInput = (file: string) => {
    const text = byFile.get(file);
    if (text === undefined) throw new Error(`unknown file in citation: ${file}`);
    return text;
  };

  const options: ChatRequestOptions = {
    num_ctx: request.numCtx,
    num_predict: request.budget,
    temperature: 0.1,
    think: request.think ?? false,
    format: DIGEST_SCHEMA,
  };

  let promptTokens = 0;
  let evalTokens = 0;
  const parts: Digest[] = [];
  for (const chunk of chunks) {
    const completed = await completeDigest(deps, buildMapMessages(request.query, chunk), options);
    promptTokens = completed.promptTokens;
    evalTokens += completed.evalTokens;
    const checked = verifyCitations(completed.digest.citations, readInput, rangesForChunk(chunk));
    parts.push(enforceEvidence({
      ...completed.digest,
      citations: checked.verified,
      citations_dropped: completed.digest.citations_dropped + checked.dropped.length,
    }));
  }

  let merged = mergeDigests(parts);
  if (chunks.length > 1) {
    const completed = await completeDigest(deps, buildReduceMessages(request.query, merged), options);
    promptTokens = completed.promptTokens;
    evalTokens += completed.evalTokens;
    const checked = verifyCitations(completed.digest.citations, readInput);
    merged = enforceEvidence({
      ...completed.digest,
      citations: dedupeCitations([...merged.citations, ...checked.verified]),
      omitted: [...merged.omitted, ...completed.digest.omitted],
      citations_dropped: merged.citations_dropped + completed.digest.citations_dropped + checked.dropped.length,
    });
  }

  return { digest: enforceEvidence(merged), chunks, promptTokens, evalTokens };
}

function enforceEvidence(digest: Digest): Digest {
  if (digest.not_found || !digest.answer.trim() || digest.citations.length > 0) return digest;
  return {
    ...digest,
    omitted: [
      ...digest.omitted,
      "model returned an answer without any verified citations; treat the answer as unsupported",
    ],
  };
}

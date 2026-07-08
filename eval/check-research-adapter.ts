#!/usr/bin/env bun
// Deterministic research adapter and pipeline quality gate. It uses an
// ephemeral loopback fixture plus injected search/fetch/completion adapters;
// it never calls a live search engine or a local model.

import { createHash } from "node:crypto";
import {
  normalizeHtmlToText,
  normalizeUrl,
  research,
  type FetchedWebPage,
  type SearchResult,
} from "../src/research.ts";
import type { ChatMessage, ChatRequestOptions } from "../src/types.ts";
import {
  INJECTION_FALSE_FACT,
  NOT_FOUND_QUERY,
  PLANTED_FACTS,
  RESEARCH_QUERY,
  SEARCH_PATHS,
  STALE_CONTRADICTION,
  startResearchFixture,
} from "./research-fixture.ts";

const PUBLIC_ORIGIN = "https://research-fixture.example";
const FIXED_NOW = new Date("2026-07-08T12:00:00.000Z");
const estimator = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

interface FakeCompletionResult {
  text: string;
  promptTokens: number;
  evalTokens: number;
}

function promptText(messages: ChatMessage[]): string {
  return messages.map((message) => message.content ?? "").join("\n");
}

function sourceUrls(text: string): string[] {
  return [...text.matchAll(/^--- (https?:\/\/\S+?):\d+-\d+ ---$/gm)].map((match) => match[1]!);
}

function citation(url: string, quote: string) {
  return { file: normalizeUrl(url), start_line: 1, end_line: 1, quote };
}

function fakeComplete(messages: ChatMessage[], _options: ChatRequestOptions): Promise<FakeCompletionResult> {
  const all = promptText(messages);
  if (messages[0]?.content?.startsWith("Plan 1 to 3 concise web search queries")) {
    const query = messages.at(-1)?.content ?? RESEARCH_QUERY;
    const text = JSON.stringify({ queries: [query] });
    return Promise.resolve({ text, promptTokens: estimator(all), evalTokens: estimator(text) });
  }

  if (all.includes(NOT_FOUND_QUERY)) {
    const text = JSON.stringify({ answer: "", not_found: true, citations: [], omitted: ["No fingerprint in fetched evidence."] });
    return Promise.resolve({ text, promptTokens: estimator(all), evalTokens: estimator(text) });
  }

  const urls = sourceUrls(all);
  const byPath = new Map(urls.map((url) => [new URL(url).pathname, url]));
  const citations = [];
  const codenameUrl = byPath.get("/facts/codename");
  const networkUrl = byPath.get("/facts/network");
  const reliabilityUrl = byPath.get("/facts/reliability");
  if (codenameUrl && all.includes(PLANTED_FACTS.codename)) citations.push(citation(codenameUrl, PLANTED_FACTS.codename));
  if (networkUrl && all.includes(PLANTED_FACTS.port)) citations.push(citation(networkUrl, PLANTED_FACTS.port));
  if (reliabilityUrl && all.includes(PLANTED_FACTS.retries)) citations.push(citation(reliabilityUrl, PLANTED_FACTS.retries));
  // Deliberately fabricated: the harness must drop it during snapshot verification.
  if (urls[0]) citations.push(citation(urls[0], "fabricated quote that is absent from every snapshot"));

  const answer = [PLANTED_FACTS.codename, PLANTED_FACTS.port, PLANTED_FACTS.retries].join(" ");
  const text = JSON.stringify({ answer, not_found: false, citations, omitted: ["Ignored unrelated and stale pages."] });
  return Promise.resolve({ text, promptTokens: estimator(all), evalTokens: estimator(text) });
}

function mappedPublicUrl(url: string): string {
  const parsed = new URL(url);
  return `${PUBLIC_ORIGIN}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function measureNormalize(html: string, rounds: number): number {
  const started = performance.now();
  for (let i = 0; i < rounds; i++) normalizeHtmlToText(html);
  return performance.now() - started;
}

async function main(): Promise<number> {
  const failures: string[] = [];
  const fixture = await startResearchFixture();
  const fetchedPublicUrls: string[] = [];
  try {
    const canonicalCases: Array<[string, string]> = [
      ["HTTPS://Example.COM:443/a?utm_source=x&z=2&fbclid=gone#fragment", "https://example.com/a?z=2"],
      ["http://example.com:80/path?b=2&a=1", "http://example.com/path?a=1&b=2"],
      [`${PUBLIC_ORIGIN}/facts/network?utm_campaign=x`, `${PUBLIC_ORIGIN}/facts/network`],
    ];
    const canonicalizePassed = canonicalCases.every(([input, expected]) => normalizeUrl(input) === expected);
    if (!canonicalizePassed) failures.push("URL canonicalization did not remove tracking/default ports or sort query parameters");

    const normalizedSample = normalizeHtmlToText(
      "<html><head><style>secret css</style><script>secret script</script></head><body><h1>A &amp; B</h1><p>Evidence&nbsp;line</p></body></html>",
    );
    const htmlNormalizePassed =
      normalizedSample.includes("A & B") &&
      normalizedSample.includes("Evidence line") &&
      !normalizedSample.includes("secret css") &&
      !normalizedSample.includes("secret script");
    if (!htmlNormalizePassed) failures.push("HTML normalization retained executable/style content or lost visible text");

    const search = async (query: string, maxResults: number): Promise<SearchResult[]> => {
      const response = await fetch(`${fixture.searchUrl}?q=${encodeURIComponent(query)}`);
      const payload = await response.json() as { results: SearchResult[] };
      return payload.results.slice(0, maxResults).map((item) => ({ ...item, url: mappedPublicUrl(item.url) }));
    };
    const fetchPage = async (publicUrl: string): Promise<FetchedWebPage> => {
      fetchedPublicUrls.push(publicUrl);
      const parsed = new URL(publicUrl);
      const response = await fetch(`${fixture.baseUrl}${parsed.pathname}${parsed.search}`);
      if (!response.ok) throw new Error(`fixture fetch returned ${response.status}`);
      return { url: publicUrl, html: await response.text() };
    };

    const started = performance.now();
    const result = await research(
      { query: RESEARCH_QUERY, maxResults: SEARCH_PATHS.length, maxPages: SEARCH_PATHS.length, numCtx: 100_000, budget: 2_048 },
      { search, fetchPage, complete: fakeComplete, estimator, now: () => FIXED_NOW },
    );
    const notFound = await research(
      { query: NOT_FOUND_QUERY, maxResults: 4, maxPages: 4, numCtx: 100_000, budget: 1_024 },
      { search, fetchPage, complete: fakeComplete, estimator, now: () => FIXED_NOW },
    );
    const wallTimeMs = performance.now() - started;

    const plantedQuotes = new Set(Object.values(PLANTED_FACTS));
    const verifiedPlanted = new Set(result.digest.citations.filter((item) => plantedQuotes.has(item.quote as typeof PLANTED_FACTS[keyof typeof PLANTED_FACTS])).map((item) => item.quote));
    const citationPrecision = result.digest.citations.length === 0 ? 0 : verifiedPlanted.size / result.digest.citations.length;
    const plantedCitationRecall = verifiedPlanted.size / plantedQuotes.size;
    const snapshotByHash = new Map(result.snapshots.map((snapshot) => [snapshot.snapshot_sha256, snapshot]));
    const snapshotVerifyPassed = result.digest.citations.every((item) => {
      const snapshot = snapshotByHash.get(item.snapshot_sha256);
      return Boolean(
        snapshot &&
        createHash("sha256").update(snapshot.text).digest("hex") === item.snapshot_sha256 &&
        snapshot.text.slice(item.start_offset, item.end_offset) === item.quote,
      );
    });
    const injectionFalseFactAdopted =
      result.digest.answer.includes(INJECTION_FALSE_FACT) ||
      result.digest.citations.some((item) => item.quote.includes(INJECTION_FALSE_FACT));
    const staleContradictionAdopted =
      result.digest.answer.includes(STALE_CONTRADICTION) ||
      result.digest.citations.some((item) => item.quote.includes(STALE_CONTRADICTION));
    const networkFetches = fetchedPublicUrls.filter((url) => new URL(url).pathname === "/facts/network").length;
    const dedupePassed = networkFetches === 1 && result.snapshots.length === 7;

    if (citationPrecision !== 1) failures.push(`citation precision ${citationPrecision} is below 1`);
    if (plantedCitationRecall !== 1) failures.push(`planted citation recall ${plantedCitationRecall} is below 1`);
    if (!snapshotVerifyPassed) failures.push("one or more accepted citations did not verify against the immutable snapshot");
    if (!notFound.digest.not_found || notFound.digest.citations.length !== 0) failures.push("answer-absent query did not return clean not_found");
    if (!dedupePassed) failures.push(`canonical duplicate was fetched ${networkFetches} times or snapshot count was not 7`);
    if (injectionFalseFactAdopted) failures.push("prompt-injection false fact was adopted");
    if (staleContradictionAdopted) failures.push("stale contradictory policy was adopted over the 2026 source");
    if (result.digest.citations_dropped < 1) failures.push("fabricated citation was not counted as dropped");
    if (result.digest.metrics.input_tokens <= result.digest.metrics.output_tokens) failures.push("fixture was not compressed");

    // Relative scaling is the primary regression signal. The generous additive
    // allowance makes tiny/contended CI runs stable; the absolute cap only catches
    // pathological hangs, not ordinary machine-speed variation.
    const smallHtml = Array.from({ length: 250 }, (_, i) => `<p>record ${i} &amp; stable text</p>`).join("");
    const largeHtml = Array.from({ length: 1_500 }, (_, i) => `<p>record ${i} &amp; stable text</p>`).join("");
    measureNormalize(smallHtml, 2); // JIT warmup
    const smallMs = measureNormalize(smallHtml, 12);
    const largeMs = measureNormalize(largeHtml, 12);
    const normalizationScalingRatio = largeMs / Math.max(smallMs, 0.01);
    const complexityPassed = largeMs <= smallMs * 12 + 250 && largeMs < 20_000;
    if (!complexityPassed) failures.push(`HTML normalization scaling regressed (${normalizationScalingRatio.toFixed(2)}x)`);

    const output = {
      passed: failures.length === 0,
      fixture: {
        live_web: false,
        local_model: false,
        search_results: SEARCH_PATHS.length,
        planted_pages: 3,
      },
      metrics: {
        citation_precision: citationPrecision,
        planted_citation_recall: plantedCitationRecall,
        citations_dropped: result.digest.citations_dropped,
        not_found: notFound.digest.not_found,
        dedupe: dedupePassed,
        injection_false_fact_adopted: injectionFalseFactAdopted,
        stale_contradiction_adopted: staleContradictionAdopted,
        input_tokens: result.digest.metrics.input_tokens,
        output_tokens: result.digest.metrics.output_tokens,
        compression_ratio: result.digest.metrics.compression_ratio,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.evalTokens,
        wall_time_ms: Number(wallTimeMs.toFixed(2)),
        fetched_page_count: result.snapshots.length,
      },
      adapter: {
        canonicalize: canonicalizePassed,
        html_normalize: htmlNormalizePassed,
        snapshot_verify: snapshotVerifyPassed,
        duplicate_network_fetches: networkFetches,
        normalization_small_ms: Number(smallMs.toFixed(2)),
        normalization_large_ms: Number(largeMs.toFixed(2)),
        normalization_scaling_ratio: Number(normalizationScalingRatio.toFixed(2)),
        complexity_gate: complexityPassed,
      },
      failures,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return failures.length === 0 ? 0 : 1;
  } finally {
    await fixture.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stdout.write(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) }, null, 2) + "\n");
  process.exitCode = 1;
}

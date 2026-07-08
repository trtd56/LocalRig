/** Shared, machine-readable contract for every preprocessing command. */
export type PreprocessInputKind = "files" | "repository" | "diff" | "web";

export interface PreprocessCitation {
  file: string;
  start_line: number;
  end_line: number;
  quote: string;
}

/** The legacy digest shape. Keep these fields stable for existing consumers. */
export interface Digest<Citation extends PreprocessCitation = PreprocessCitation> {
  answer: string;
  not_found: boolean;
  citations: Citation[];
  omitted: string[];
  citations_dropped: number;
}

export interface PreprocessMetrics {
  /** Tokens in the source presented for preprocessing (estimated when needed). */
  input_tokens: number;
  /** Tokens in the digest (provider count when available, otherwise estimated). */
  output_tokens: number;
  /** output_tokens / input_tokens. Zero when input_tokens is zero. */
  compression_ratio: number;
  /** Aggregate model prompt/completion counters, when the provider exposed them. */
  prompt_tokens: number;
  completion_tokens: number;
  token_measurement: "provider" | "estimated" | "mixed";
}

export interface PreprocessResult<Citation extends PreprocessCitation = PreprocessCitation>
  extends Digest<Citation> {
  input_kind: PreprocessInputKind;
  metrics: PreprocessMetrics;
}

export interface PreprocessMetricInput {
  inputTokens: number;
  outputTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  inputMeasured?: boolean;
  outputMeasured?: boolean;
}

function safeCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function buildPreprocessMetrics(input: PreprocessMetricInput): PreprocessMetrics {
  const inputTokens = safeCount(input.inputTokens);
  const outputTokens = safeCount(input.outputTokens);
  const inputMeasured = input.inputMeasured ?? false;
  const outputMeasured = input.outputMeasured ?? false;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    compression_ratio: inputTokens === 0 ? 0 : Number((outputTokens / inputTokens).toFixed(4)),
    prompt_tokens: safeCount(input.promptTokens),
    completion_tokens: safeCount(input.completionTokens),
    token_measurement: inputMeasured && outputMeasured
      ? "provider"
      : inputMeasured || outputMeasured
        ? "mixed"
        : "estimated",
  };
}

export function toPreprocessResult<Citation extends PreprocessCitation>(
  digest: Digest<Citation>,
  inputKind: PreprocessInputKind,
  metricInput: PreprocessMetricInput,
): PreprocessResult<Citation> {
  return { ...digest, input_kind: inputKind, metrics: buildPreprocessMetrics(metricInput) };
}

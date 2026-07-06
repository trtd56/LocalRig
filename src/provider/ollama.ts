import type {
  ChatMessage,
  ChatRequestOptions,
  ChatChunk,
  ChatResponse,
  ToolDef,
  ToolCall,
} from "../types.ts";

interface OllamaStreamLine {
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: ToolCall[];
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Strip harness-internal fields (underscore-prefixed) before sending. */
function wireMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_name) out.tool_name = m.tool_name;
  // NOTE: thinking is intentionally NOT sent back — replaying old thinking
  // wastes context and Qwen re-derives it each turn.
  return out;
}

export class OllamaClient {
  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  /**
   * Stream one assistant turn. onChunk receives incremental text for the UI;
   * the resolved ChatResponse carries the assembled message + real token counts.
   */
  async chat(
    messages: ChatMessage[],
    tools: ToolDef[],
    options: ChatRequestOptions,
    onChunk: (chunk: ChatChunk) => void,
    signal: AbortSignal,
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      options: {
        num_ctx: options.num_ctx,
        num_predict: options.num_predict ?? -1,
        temperature: options.temperature,
        top_p: options.top_p,
        top_k: options.top_k,
        presence_penalty: options.presence_penalty,
      },
      messages: messages.map(wireMessage),
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    // Only send `think` when the caller set it explicitly — omitting it lets
    // the model use its default (thinking on for this Qwen build).
    if (options.think !== undefined) body.think = options.think;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
      // Bun's fetch aborts after 300s of socket idle time ("The operation
      // timed out"). Ollama buffers a tool call until its JSON is fully
      // parsed, so generating one large write call can exceed that in
      // silence. Undocumented Bun extension; verified on Bun 1.2.21.
      timeout: false,
    } as RequestInit);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    let promptTokens = 0;
    let evalTokens = 0;
    let doneReason = "";

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed: OllamaStreamLine;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // partial/garbled line — skip
        }
        if (parsed.error) throw new Error(`Ollama error: ${parsed.error}`);
        const m = parsed.message;
        if (m?.thinking) {
          thinking += m.thinking;
          onChunk({ thinking: m.thinking });
        }
        if (m?.content) {
          content += m.content;
          onChunk({ content: m.content });
        }
        if (m?.tool_calls) {
          toolCalls.push(...m.tool_calls);
          onChunk({ toolCall: true });
        }
        if (parsed.done) {
          promptTokens = parsed.prompt_eval_count ?? 0;
          evalTokens = parsed.eval_count ?? 0;
          doneReason = parsed.done_reason ?? "";
        }
      }
    }

    const message: ChatMessage = { role: "assistant", content };
    if (thinking) message.thinking = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      message,
      promptTokens,
      evalTokens,
      truncated: doneReason === "length",
    };
  }

  /** Non-streaming one-shot completion without tools (used for compaction). */
  async complete(
    messages: ChatMessage[],
    options: ChatRequestOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        options: {
          num_ctx: options.num_ctx,
          num_predict: options.num_predict ?? 4096,
          temperature: options.temperature ?? 0.2,
        },
        messages: messages.map(wireMessage),
      }),
      signal,
      // stream:false means zero bytes until generation finishes — always
      // "idle" from Bun's 300s-timeout perspective (see chat() above).
      timeout: false,
    } as RequestInit);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { message?: { content?: string }; error?: string };
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    return data.message?.content ?? "";
  }
}

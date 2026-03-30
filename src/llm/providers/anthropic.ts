import type { LLMMessage, LLMResponse } from "../../core/types.ts";

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
}

interface AnthropicChatResponse {
  content: Array<{ type: string; text: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type: string; text?: string };
  message?: {
    usage: { input_tokens: number; output_tokens: number };
  };
  usage?: { output_tokens: number };
}

// Cost per 1M tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 15, output: 75 },
};

export class AnthropicProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: AnthropicConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(
      /\/$/,
      "",
    );
  }

  async complete(
    messages: LLMMessage[],
    model: string,
    options: {
      temperature?: number;
      maxTokens?: number;
      format?: "json" | undefined;
    } = {},
  ): Promise<LLMResponse> {
    const start = performance.now();

    // Separate system message from conversation
    const systemMsg = messages.find((m) => m.role === "system");
    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      messages: chatMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as AnthropicChatResponse;
    const durationMs = performance.now() - start;

    const content = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    const pricing = PRICING[model] ?? { input: 0, output: 0 };
    const estimatedCostUsd =
      (data.usage.input_tokens * pricing.input +
        data.usage.output_tokens * pricing.output) /
      1_000_000;

    return {
      content,
      model,
      tokenUsage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        estimatedCostUsd,
      },
      durationMs,
    };
  }

  async *stream(
    messages: LLMMessage[],
    model: string,
    options: {
      temperature?: number;
      maxTokens?: number;
      format?: "json" | undefined;
    } = {},
  ): AsyncGenerator<{ chunk: string; done: boolean; tokenUsage?: LLMResponse["tokenUsage"]; durationMs?: number }> {
    const start = performance.now();

    // Separate system message from conversation
    const systemMsg = messages.find((m) => m.role === "system");
    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model,
      messages: chatMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${text}`);
    }

    if (!response.body) {
      throw new Error("Anthropic streaming response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          // SSE format: "event: <type>" followed by "data: <json>"
          if (trimmed.startsWith("event:")) continue;

          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            let event: AnthropicStreamEvent;
            try {
              event = JSON.parse(jsonStr) as AnthropicStreamEvent;
            } catch {
              continue;
            }

            if (event.type === "message_start" && event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
            }

            if (event.type === "content_block_delta" && event.delta?.text) {
              yield { chunk: event.delta.text, done: false };
            }

            if (event.type === "message_delta" && event.usage) {
              outputTokens = event.usage.output_tokens;
            }

            if (event.type === "message_stop") {
              const durationMs = performance.now() - start;
              const pricing = PRICING[model] ?? { input: 0, output: 0 };
              const estimatedCostUsd =
                (inputTokens * pricing.input + outputTokens * pricing.output) /
                1_000_000;

              yield {
                chunk: "",
                done: true,
                tokenUsage: {
                  promptTokens: inputTokens,
                  completionTokens: outputTokens,
                  estimatedCostUsd,
                },
                durationMs,
              };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

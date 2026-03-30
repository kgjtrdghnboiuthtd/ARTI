import type { LLMMessage, LLMResponse } from "../../core/types.ts";

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
}

interface OpenAIChatResponse {
  choices: Array<{ message: { content: string } }>;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  } | null;
}

export class OpenAIProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: OpenAIConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com").replace(
      /\/$/,
      "",
    );
  }

  /** Fetch available models from the /v1/models endpoint */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id).sort();
    } catch {
      return [];
    }
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

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    };

    if (options.format === "json") {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const durationMs = performance.now() - start;

    return {
      content: data.choices[0]?.message.content ?? "",
      model,
      tokenUsage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        estimatedCostUsd: 0, // Pricing varies too much
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

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.format === "json") {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${text}`);
    }

    if (!response.body) {
      throw new Error("OpenAI streaming response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;

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

          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);

            if (jsonStr === "[DONE]") {
              const durationMs = performance.now() - start;
              yield {
                chunk: "",
                done: true,
                tokenUsage: {
                  promptTokens,
                  completionTokens,
                  estimatedCostUsd: 0,
                },
                durationMs,
              };
              continue;
            }

            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
            } catch {
              continue;
            }

            // Capture usage from the final chunk (stream_options: include_usage)
            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens;
              completionTokens = chunk.usage.completion_tokens;
            }

            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              yield { chunk: content, done: false };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

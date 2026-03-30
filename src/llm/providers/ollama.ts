import type { LLMMessage, LLMResponse } from "../../core/types.ts";

export interface OllamaConfig {
  baseUrl: string;
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaStreamChunk {
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider {
  private baseUrl: string;

  constructor(config: OllamaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
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
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
    };

    if (options.format === "json") {
      body.format = "json";
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Ollama API error (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const durationMs = performance.now() - start;

    return {
      content: data.message.content,
      model,
      tokenUsage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        estimatedCostUsd: 0, // Local models are free
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
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
    };

    if (options.format === "json") {
      body.format = "json";
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Ollama API error (${response.status}): ${text}`,
      );
    }

    if (!response.body) {
      throw new Error("Ollama streaming response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse NDJSON: each line is a separate JSON object
        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const chunk = JSON.parse(trimmed) as OllamaStreamChunk;

          if (chunk.done) {
            const durationMs = performance.now() - start;
            yield {
              chunk: chunk.message.content,
              done: true,
              tokenUsage: {
                promptTokens: chunk.prompt_eval_count ?? 0,
                completionTokens: chunk.eval_count ?? 0,
                estimatedCostUsd: 0,
              },
              durationMs,
            };
          } else {
            yield {
              chunk: chunk.message.content,
              done: false,
            };
          }
        }
      }

      // Handle any remaining data in the buffer
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer.trim()) as OllamaStreamChunk;
          const durationMs = performance.now() - start;
          yield {
            chunk: chunk.message.content,
            done: chunk.done,
            tokenUsage: chunk.done
              ? {
                  promptTokens: chunk.prompt_eval_count ?? 0,
                  completionTokens: chunk.eval_count ?? 0,
                  estimatedCostUsd: 0,
                }
              : undefined,
            durationMs: chunk.done ? durationMs : undefined,
          };
        } catch { /* incomplete JSON in buffer, ignore */ }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      const data = (await res.json()) as {
        models: Array<{ name: string }>;
      };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  /** List models filtered by mode: "local" excludes :cloud, "cloud" keeps only :cloud, "both" returns all */
  async listModelsByMode(mode: "local" | "cloud" | "both" = "both"): Promise<string[]> {
    const all = await this.listModels();
    if (mode === "local") return all.filter((m) => !m.endsWith(":cloud"));
    if (mode === "cloud") return all.filter((m) => m.endsWith(":cloud"));
    return all;
  }
}

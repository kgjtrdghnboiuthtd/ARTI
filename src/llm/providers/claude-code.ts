import type { LLMMessage, LLMResponse } from "../../core/types.ts";

interface ClaudeCodeStreamMessage {
  type: string;
  subtype?: string;
  content_block_delta?: { delta?: { text?: string } };
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  // assistant message with content blocks
  content?: Array<{ type: string; text?: string }>;
}

export class ClaudeCodeProvider {
  private binaryPath: string;

  constructor(opts?: { binaryPath?: string }) {
    this.binaryPath =
      opts?.binaryPath ??
      Bun.which("claude") ??
      `${process.env.HOME}/.local/bin/claude`;
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
    const prompt = this.serializeMessages(messages, options.format === "json");

    const args = [
      this.binaryPath,
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--model",
      model,
    ];

    const start = performance.now();

    const proc = Bun.spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });

    // Timeout 120s
    const timeout = setTimeout(() => proc.kill(), 120_000);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    clearTimeout(timeout);
    const durationMs = performance.now() - start;

    if (exitCode !== 0) {
      const msg = stderr.trim() || stdout.trim() || "Unknown error";
      // Use (500) pattern for retryable errors
      throw new Error(`Claude Code CLI error (500): ${msg}`);
    }

    // Parse the JSON output
    let data: {
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };

    try {
      data = JSON.parse(stdout);
    } catch {
      // Sometimes the CLI outputs text before JSON — try to find the JSON
      const jsonStart = stdout.indexOf("{");
      if (jsonStart >= 0) {
        data = JSON.parse(stdout.slice(jsonStart));
      } else {
        throw new Error(
          `Claude Code CLI returned invalid JSON (500): ${stdout.slice(0, 200)}`,
        );
      }
    }

    return {
      content: data.result ?? stdout,
      model,
      tokenUsage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        estimatedCostUsd: data.total_cost_usd ?? 0,
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
    const prompt = this.serializeMessages(messages, options.format === "json");

    const args = [
      this.binaryPath,
      "--print",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--model",
      model,
    ];

    const start = performance.now();

    const proc = Bun.spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => proc.kill(), 120_000);

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let totalCostUsd = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let msg: ClaudeCodeStreamMessage;
          try {
            msg = JSON.parse(trimmed) as ClaudeCodeStreamMessage;
          } catch {
            continue;
          }

          // assistant messages contain text content blocks
          if (msg.type === "assistant" && msg.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                yield { chunk: block.text, done: false };
              }
            }
          }

          // result message at the end
          if (msg.type === "result") {
            if (msg.result) {
              yield { chunk: msg.result, done: false };
            }
            inputTokens = msg.usage?.input_tokens ?? 0;
            outputTokens = msg.usage?.output_tokens ?? 0;
            totalCostUsd = msg.total_cost_usd ?? 0;
          }
        }
      }

      // Handle remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim()) as ClaudeCodeStreamMessage;
          if (msg.type === "result") {
            inputTokens = msg.usage?.input_tokens ?? inputTokens;
            outputTokens = msg.usage?.output_tokens ?? outputTokens;
            totalCostUsd = msg.total_cost_usd ?? totalCostUsd;
          }
        } catch {
          // ignore partial JSON
        }
      }
    } finally {
      reader.releaseLock();
      clearTimeout(timeout);
    }

    await proc.exited;
    const durationMs = performance.now() - start;

    yield {
      chunk: "",
      done: true,
      tokenUsage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        estimatedCostUsd: totalCostUsd,
      },
      durationMs,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn([this.binaryPath, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => proc.kill(), 5_000);
      const code = await proc.exited;
      clearTimeout(timeout);
      return code === 0;
    } catch {
      return false;
    }
  }

  private serializeMessages(messages: LLMMessage[], jsonMode: boolean): string {
    const parts: string[] = [];

    for (const msg of messages) {
      parts.push(`[${msg.role}]\n${msg.content}`);
    }

    let prompt = parts.join("\n\n");

    if (jsonMode) {
      prompt += "\n\nYou MUST respond with valid JSON only. No markdown, no explanation.";
    }

    return prompt;
  }
}

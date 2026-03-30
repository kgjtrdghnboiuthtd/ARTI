import type { LLMMessage, LLMResponse } from "../core/types.ts";
import type { LLMClient, CompletionOptions } from "../llm/client.ts";
import type { EventBus } from "../core/events.ts";

export interface AgentContext {
  llm: LLMClient;
  events: EventBus;
}

export abstract class BaseAgent {
  protected name: string;
  protected systemPrompt: string;
  protected ctx: AgentContext;

  constructor(name: string, systemPrompt: string, ctx: AgentContext) {
    this.name = name;
    this.systemPrompt = systemPrompt;
    this.ctx = ctx;
  }

  protected async call(
    userMessage: string,
    model: string,
    options: CompletionOptions = {},
  ): Promise<LLMResponse> {
    const messages: LLMMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userMessage },
    ];

    await this.ctx.events.emit("llm:call", {
      model,
      promptTokens: 0, // Estimated after response
    });

    const response = await this.ctx.llm.complete(messages, model, options);

    await this.ctx.events.emit("llm:response", response);

    return response;
  }

  protected async callWithHistory(
    messages: LLMMessage[],
    model: string,
    options: CompletionOptions = {},
  ): Promise<LLMResponse> {
    const fullMessages: LLMMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...messages,
    ];

    const response = await this.ctx.llm.complete(fullMessages, model, options);
    await this.ctx.events.emit("llm:response", response);

    return response;
  }

  /**
   * Call the LLM and parse the response as JSON.
   * Forces JSON format and validates the output.
   */
  protected async callJSON<T>(
    userMessage: string,
    model: string,
    options: CompletionOptions = {},
  ): Promise<{ parsed: T; response: LLMResponse }> {
    const response = await this.call(userMessage, model, {
      ...options,
      format: "json",
    });

    let parsed: T;
    try {
      parsed = JSON.parse(extractJSON(response.content)) as T;
    } catch (e) {
      throw new Error(`Failed to parse JSON from LLM response: ${(e as Error).message}\nRaw: ${response.content.slice(0, 500)}`);
    }
    return { parsed, response };
  }
}

/** Strip markdown fences and find the JSON object/array in a string */
function extractJSON(text: string): string {
  let s = text.trim();

  // Remove ```json ... ``` or ``` ... ``` fences
  const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1]!.trim();

  // Find first { or [ and last matching } or ]
  const start = s.search(/[\[{]/);
  if (start === -1) return s;

  const opener = s[start];
  const closer = opener === "{" ? "}" : "]";
  const lastClose = s.lastIndexOf(closer);
  if (lastClose === -1) return s;

  return s.slice(start, lastClose + 1);
}

import type { LLMMessage, LLMResponse } from "../core/types.ts";
import type { ArctiConfig, ProviderName } from "../config.ts";
import { PROVIDER_MODELS } from "../config.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { ClaudeCodeProvider } from "./providers/claude-code.ts";
import { logger } from "../observability/logger.ts";

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  format?: "json" | undefined;
}

type Provider = OllamaProvider | AnthropicProvider | OpenAIProvider | ClaudeCodeProvider;

export class LLMClient {
  private registry = new Map<ProviderName, Provider>();
  private config: ArctiConfig;
  private cache = new Map<string, LLMResponse>();
  private log = logger.child("llm-client");
  /** Available Ollama models filtered by mode (populated after init()) */
  private ollamaModels: string[] = [];

  constructor(config: ArctiConfig) {
    this.config = config;
    this.initProviders(config);
  }

  /**
   * Re-initialize providers from updated config (e.g. after enabling/disabling a provider or adding an API key).
   */
  reinit(config?: ArctiConfig): void {
    if (config) this.config = config;
    this.registry.clear();
    this.initProviders(this.config);
  }

  /**
   * Async init: detect Ollama models by configured mode and update PROVIDER_MODELS.
   * Must be called after constructor.
   */
  async init(): Promise<void> {
    const ollama = this.registry.get("ollama") as OllamaProvider | undefined;
    if (!ollama) return;

    try {
      const mode = this.config.providers.ollama.mode ?? "both";
      this.ollamaModels = await ollama.listModelsByMode(mode);
      if (this.ollamaModels.length > 0) {
        PROVIDER_MODELS.ollama = this.ollamaModels;
        this.log.info(`Ollama models (${mode}): ${this.ollamaModels.join(", ")}`);

        // Validate that configured default models are actually available
        this.validateOllamaModels();
      } else {
        this.log.warn(`No Ollama models found for mode "${mode}"`);
      }
    } catch {
      this.log.warn("Could not detect Ollama models");
    }
  }

  /** Check configured models are available in Ollama, warn and fix if not */
  private validateOllamaModels(): void {
    if (this.config.defaultProvider !== "ollama") return;
    if (this.ollamaModels.length === 0) return;

    const tiers = ["tier1", "tier2", "tier3"] as const;
    for (const tier of tiers) {
      const model = this.config.defaultModels[tier];
      if (!this.isOllamaModelAvailable(model)) {
        const fallback = this.ollamaModels[0]!;
        this.log.warn(`Model "${model}" not available in Ollama, falling back to "${fallback}" for ${tier}`);
        this.config.defaultModels[tier] = fallback;
      }
    }
  }

  /** Check if a model is available in Ollama (respects configured mode) */
  isOllamaModelAvailable(model: string): boolean {
    if (this.ollamaModels.length === 0) return true; // not initialized yet, assume ok
    return this.ollamaModels.some(
      (m) => m === model || m.startsWith(model + ":") || model.startsWith(m.split(":")[0]!),
    );
  }

  /** Get list of available Ollama models (filtered by mode) */
  getOllamaModels(): string[] {
    return this.ollamaModels;
  }

  /** Fetch models from an OpenAI-compatible provider (openrouter, openai, grok) */
  async fetchProviderModels(providerName: string): Promise<string[]> {
    const provider = this.registry.get(providerName) as OpenAIProvider | undefined;
    if (!provider || typeof provider.listModels !== "function") return [];
    return provider.listModels();
  }

  private initProviders(config: ArctiConfig): void {
    const p = config.providers;

    // Ollama
    if (p.ollama.enabled) {
      this.registry.set("ollama", new OllamaProvider({ baseUrl: p.ollama.baseUrl }));
    }

    // Anthropic
    if (p.anthropic.enabled) {
      const apiKey = process.env[p.anthropic.apiKeyEnv ?? "ANTHROPIC_API_KEY"] ?? "";
      this.registry.set("anthropic", new AnthropicProvider({
        apiKey,
        baseUrl: p.anthropic.baseUrl,
      }));
    }

    // OpenAI
    if (p.openai.enabled) {
      const apiKey = process.env[p.openai.apiKeyEnv ?? "OPENAI_API_KEY"] ?? "";
      this.registry.set("openai", new OpenAIProvider({
        apiKey,
        baseUrl: p.openai.baseUrl,
      }));
    }

    // Grok (xAI — OpenAI-compatible API)
    if (p.grok.enabled) {
      const apiKey = process.env[p.grok.apiKeyEnv ?? "XAI_API_KEY"] ?? "";
      this.registry.set("grok", new OpenAIProvider({
        apiKey,
        baseUrl: p.grok.baseUrl ?? "https://api.x.ai",
      }));
    }

    // OpenRouter (OpenAI-compatible API)
    if (p.openrouter.enabled) {
      const apiKey = process.env[p.openrouter.apiKeyEnv ?? "OPENROUTER_API_KEY"] ?? "";
      this.registry.set("openrouter", new OpenAIProvider({
        apiKey,
        baseUrl: p.openrouter.baseUrl ?? "https://openrouter.ai/api",
      }));
    }

    // Claude Code CLI
    if (p["claude-code"].enabled) {
      this.registry.set("claude-code", new ClaudeCodeProvider());
    }

    // If default provider isn't in registry, try to enable it
    if (!this.registry.has(config.defaultProvider)) {
      if (config.defaultProvider === "ollama") {
        this.registry.set("ollama", new OllamaProvider({ baseUrl: p.ollama.baseUrl }));
      } else if (config.defaultProvider === "claude-code") {
        this.registry.set("claude-code", new ClaudeCodeProvider());
      }
    }
  }

  async complete(
    messages: LLMMessage[],
    model: string,
    options: CompletionOptions = {},
    providerName?: ProviderName,
  ): Promise<LLMResponse> {
    const cacheKey = this.getCacheKey(messages, model, options);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const provider = providerName
      ? this.getProvider(providerName)
      : this.getProviderForModel(model);

    const response = await this.callWithRetry(
      () => provider.complete(messages, model, options),
      3,
    );

    this.cache.set(cacheKey, response);
    if (this.cache.size > 100) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    return response;
  }

  async *stream(
    messages: LLMMessage[],
    model: string,
    options: CompletionOptions = {},
    providerName?: ProviderName,
  ): AsyncGenerator<{ chunk: string; done: boolean; tokenUsage?: LLMResponse["tokenUsage"]; durationMs?: number }> {
    const provider = providerName
      ? this.getProvider(providerName)
      : this.getProviderForModel(model);

    // Check if provider has a stream method
    if ("stream" in provider && typeof provider.stream === "function") {
      yield* provider.stream(messages, model, options);
    } else {
      // Fallback: call complete() and yield as a single chunk
      const response = await provider.complete(messages, model, options);
      yield {
        chunk: response.content,
        done: true,
        tokenUsage: response.tokenUsage,
        durationMs: response.durationMs,
      };
    }
  }

  /** Get a provider by name */
  getProvider(name: ProviderName): Provider {
    const p = this.registry.get(name);
    if (!p) throw new Error(`Provider "${name}" is not enabled or configured.`);
    return p;
  }

  /** List all available (initialized) providers */
  listAvailableProviders(): ProviderName[] {
    return [...this.registry.keys()];
  }

  /** Get the Ollama provider (for check command) */
  getOllamaProvider(): OllamaProvider | null {
    return (this.registry.get("ollama") as OllamaProvider) ?? null;
  }

  /** Get the Claude Code provider (for check command) */
  getClaudeCodeProvider(): ClaudeCodeProvider | null {
    return (this.registry.get("claude-code") as ClaudeCodeProvider) ?? null;
  }

  private getProviderForModel(model: string): Provider {
    // Claude Code short names
    if (["haiku", "sonnet", "opus"].includes(model)) {
      const cc = this.registry.get("claude-code");
      if (cc) return cc;
    }

    // Cloud model patterns
    const isCloudModel =
      model.startsWith("claude-") ||
      model.startsWith("gpt-") ||
      model.startsWith("o1") ||
      model.startsWith("o3");

    if (isCloudModel) {
      // Try Anthropic for claude-* models
      if (model.startsWith("claude-")) {
        const anthropic = this.registry.get("anthropic");
        if (anthropic) return anthropic;
      }
      // Try OpenAI for gpt-*/o1/o3 models
      if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
        const openai = this.registry.get("openai");
        if (openai) return openai;
      }
      // Try Grok
      if (model.startsWith("grok-")) {
        const grok = this.registry.get("grok");
        if (grok) return grok;
      }
      // Try OpenRouter for path-like models (e.g. "anthropic/claude-sonnet-4-6")
      if (model.includes("/")) {
        const or = this.registry.get("openrouter");
        if (or) return or;
      }
    }

    // Grok models
    if (model.startsWith("grok-")) {
      const grok = this.registry.get("grok");
      if (grok) return grok;
    }

    // OpenRouter path models
    if (model.includes("/")) {
      const or = this.registry.get("openrouter");
      if (or) return or;
    }

    // Default to the default provider
    const defaultP = this.registry.get(this.config.defaultProvider);
    if (defaultP) return defaultP;

    // Fallback to Ollama
    const ollama = this.registry.get("ollama");
    if (ollama) return ollama;

    throw new Error(
      `No provider available for model "${model}". Enable a provider in config.`,
    );
  }

  private async callWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        const status = this.extractStatus(error);

        if (status && [429, 500, 502, 503].includes(status)) {
          const delay = Math.min(1000 * 2 ** i, 10000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  private extractStatus(error: unknown): number | null {
    const msg = error instanceof Error ? error.message : String(error);
    const match = msg.match(/\((\d{3})\)/);
    return match ? parseInt(match[1]!, 10) : null;
  }

  private getCacheKey(
    messages: LLMMessage[],
    model: string,
    options: CompletionOptions,
  ): string {
    const data = JSON.stringify({ messages, model, options });
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return `${model}:${hash}`;
  }
}

import type { Complexity } from "../core/types.ts";
import type { ArctiConfig, ProviderName } from "../config.ts";
import { PROVIDER_DEFAULT_TIERS } from "../config.ts";
import { logger } from "../observability/logger.ts";

const TIER_ORDER: Complexity[] = ["low", "medium", "high"];

export class ModelRouter {
  private config: ArctiConfig;
  private log = logger.child("router");
  private ollamaModels: string[] = [];

  constructor(config: ArctiConfig) {
    this.config = config;
  }

  /** Set available Ollama models for availability-aware selection */
  setOllamaModels(models: string[]): void {
    this.ollamaModels = models;
  }

  /**
   * Select the model for a given complexity + escalation.
   * Optional overrideProvider forces a specific provider's model set.
   */
  select(complexity: Complexity, escalation: number = 0, overrideProvider?: ProviderName): string {
    const baseIndex = TIER_ORDER.indexOf(complexity);
    const effectiveIndex = Math.min(baseIndex + escalation, 2);
    const tier = TIER_ORDER[effectiveIndex]!;

    return this.getModelForTier(tier, overrideProvider);
  }

  /**
   * Get model + provider info.
   */
  selectWithProvider(
    complexity: Complexity,
    escalation: number = 0,
    overrideProvider?: ProviderName,
  ): { model: string; provider: ProviderName } {
    const baseIndex = TIER_ORDER.indexOf(complexity);
    const effectiveIndex = Math.min(baseIndex + escalation, 2);
    const tier = TIER_ORDER[effectiveIndex]!;

    const provider = overrideProvider ?? this.config.defaultProvider;
    const model = this.getModelForTier(tier, overrideProvider);

    return { model, provider };
  }

  private getModelForTier(tier: Complexity, overrideProvider?: ProviderName): string {
    const key = this.tierKey(tier);
    const provider = overrideProvider ?? this.config.defaultProvider;

    let model: string | undefined;

    // Use config defaultModels when no override or same as default
    if ((!overrideProvider || overrideProvider === this.config.defaultProvider) && this.config.defaultModels[key]) {
      model = this.config.defaultModels[key];
    } else {
      // Use the provider's default tiers
      const tiers = PROVIDER_DEFAULT_TIERS[provider];
      if (tiers) {
        model = tiers[key];
      } else {
        // Legacy fallback
        const mode = this.config.providerMode;
        if (mode === "local") model = this.config.local.models[key];
        else if (mode === "cloud") model = this.config.cloud.models[key];
        else if (mode === "hybrid") model = this.config.hybrid[key].model;
        else model = this.config.defaultModels[key];
      }
    }

    // Guard: for Ollama, ensure the selected model is actually available
    if (provider === "ollama" && this.ollamaModels.length > 0 && model) {
      const isAvailable = this.ollamaModels.some(
        (m) => m === model || m.startsWith(model + ":") || model.startsWith(m.split(":")[0]!),
      );
      if (!isAvailable) {
        const fallback = this.config.defaultModels[key];
        this.log.warn(`Model "${model}" not available in Ollama, using "${fallback}"`);
        return fallback;
      }
    }

    if (!model) model = this.config.defaultModels?.medium ?? this.ollamaModels[0] ?? "gemma3:12b";

    return model;
  }

  private tierKey(tier: Complexity): "tier1" | "tier2" | "tier3" {
    switch (tier) {
      case "low": return "tier1";
      case "medium": return "tier2";
      case "high": return "tier3";
    }
  }

  nextTier(currentComplexity: Complexity): Complexity | null {
    const idx = TIER_ORDER.indexOf(currentComplexity);
    if (idx >= TIER_ORDER.length - 1) return null;
    return TIER_ORDER[idx + 1]!;
  }

  describe(): string {
    const lines = [`Provider: ${this.config.defaultProvider}`];

    for (const tier of TIER_ORDER) {
      const { model, provider } = this.selectWithProvider(tier);
      lines.push(`  ${tier}: ${model} (${provider})`);
    }

    return lines.join("\n");
  }
}

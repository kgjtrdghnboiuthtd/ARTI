import type { TaskSpec } from "./types.ts";
import type { ArctiConfig, ProviderName } from "../config.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CostEstimate {
  estimatedTasks: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  estimatedDurationMinutes: number;
  breakdown: {
    tier: string;
    tasks: number;
    tokensPerTask: number;
    costPerTask: number;
  }[];
}

// ─── Token estimates by complexity ──────────────────────────────────────────

const TOKENS_BY_COMPLEXITY: Record<string, number> = {
  low: 2000,
  medium: 5000,
  high: 10000,
};

// ─── Pricing per 1k tokens by model ────────────────────────────────────────

const PRICING_PER_1K: Record<string, number> = {
  // Ollama (local) — free
  "qwen2.5:3b": 0,
  "gemma3:12b": 0,
  "llama3.1:70b": 0,

  // Anthropic
  "claude-haiku-4-5-20251001": 0.001,
  "claude-sonnet-4-6": 0.003,
  "claude-opus-4-6": 0.015,

  // OpenAI
  "gpt-4o-mini": 0.0015,
  "gpt-4o": 0.005,
  "o3": 0.005,
};

// ─── Average tokens/sec by provider (for duration estimate) ─────────────────

const TOKENS_PER_SEC: Record<ProviderName, number> = {
  ollama: 30,
  anthropic: 80,
  openai: 70,
  grok: 70,
  openrouter: 60,
  "claude-code": 80,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isOllamaModel(model: string): boolean {
  // Ollama models typically have a colon (e.g. "gemma3:12b") or no known pricing
  return model.includes(":") && !(model in PRICING_PER_1K && PRICING_PER_1K[model]! > 0);
}

function getPricePerToken(model: string, provider: ProviderName): number {
  // Check exact match first
  if (model in PRICING_PER_1K) return PRICING_PER_1K[model]!;

  // Ollama models are free
  if (provider === "ollama") return 0;

  // Fallback heuristics by model name patterns
  if (model.includes("haiku")) return 0.001;
  if (model.includes("sonnet")) return 0.003;
  if (model.includes("opus")) return 0.015;
  if (model.includes("gpt-4o-mini")) return 0.0015;
  if (model.includes("gpt-4o")) return 0.005;

  // Default: mid-range pricing
  return 0.003;
}

function getTierForComplexity(complexity: string): "tier1" | "tier2" | "tier3" {
  switch (complexity) {
    case "low":
      return "tier1";
    case "high":
      return "tier3";
    default:
      return "tier2";
  }
}

// ─── Main Estimator ─────────────────────────────────────────────────────────

export function estimateCost(tasks: TaskSpec[], config: ArctiConfig): CostEstimate {
  const provider = config.defaultProvider;
  const models = config.defaultModels;
  const tokensPerSec = TOKENS_PER_SEC[provider] ?? 50;

  // Group tasks by tier
  const tierGroups: Record<string, { tasks: number; tokensPerTask: number; model: string }> = {
    tier1: { tasks: 0, tokensPerTask: 0, model: models.tier1 },
    tier2: { tasks: 0, tokensPerTask: 0, model: models.tier2 },
    tier3: { tasks: 0, tokensPerTask: 0, model: models.tier3 },
  };

  for (const task of tasks) {
    // Only count atomic tasks (non-atomic are decomposed, not executed)
    if (!task.isAtomic) continue;

    const tier = getTierForComplexity(task.complexity);
    const tokens = TOKENS_BY_COMPLEXITY[task.complexity] ?? 5000;
    tierGroups[tier]!.tasks += 1;
    tierGroups[tier]!.tokensPerTask = tokens;
  }

  let totalTokens = 0;
  let totalCostUsd = 0;
  let totalTasks = 0;
  const breakdown: CostEstimate["breakdown"] = [];

  for (const [tier, group] of Object.entries(tierGroups)) {
    if (group.tasks === 0) continue;

    const pricePerK = getPricePerToken(group.model, provider);

    // Include verification overhead: 1 additional LLM call per task at tier1 cost
    const verificationTokens = TOKENS_BY_COMPLEXITY["low"]!; // tier1 verification call
    const verificationPricePerK = getPricePerToken(models.tier1, provider);

    const taskTokens = group.tokensPerTask + verificationTokens;
    const taskCost =
      (group.tokensPerTask / 1000) * pricePerK +
      (verificationTokens / 1000) * verificationPricePerK;

    totalTokens += taskTokens * group.tasks;
    totalCostUsd += taskCost * group.tasks;
    totalTasks += group.tasks;

    breakdown.push({
      tier,
      tasks: group.tasks,
      tokensPerTask: taskTokens,
      costPerTask: Math.round(taskCost * 1_000_000) / 1_000_000, // Round to 6 decimal places
    });
  }

  // Estimate duration: total tokens / tokens per second, converted to minutes
  const estimatedDurationMinutes = totalTokens > 0
    ? Math.round((totalTokens / tokensPerSec / 60) * 100) / 100
    : 0;

  return {
    estimatedTasks: totalTasks,
    estimatedTokens: totalTokens,
    estimatedCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    estimatedDurationMinutes,
    breakdown,
  };
}

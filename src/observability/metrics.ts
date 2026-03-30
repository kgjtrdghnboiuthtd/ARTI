import type { TokenUsage, LLMResponse } from "../core/types.ts";
import type { EventBus } from "../core/events.ts";
import chalk from "chalk";

interface ModelMetrics {
  calls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

export class MetricsCollector {
  private byModel = new Map<string, ModelMetrics>();
  private startTime = Date.now();

  /** Subscribe to events to auto-collect metrics */
  attach(events: EventBus): void {
    events.on("llm:response", (response: LLMResponse) => {
      this.record(response);
    });
  }

  record(response: LLMResponse): void {
    const existing = this.byModel.get(response.model) ?? {
      calls: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
    };

    existing.calls++;
    existing.totalPromptTokens += response.tokenUsage.promptTokens;
    existing.totalCompletionTokens += response.tokenUsage.completionTokens;
    existing.totalCostUsd += response.tokenUsage.estimatedCostUsd;
    existing.totalDurationMs += response.durationMs;

    this.byModel.set(response.model, existing);
  }

  getTotals(): TokenUsage & { totalCalls: number; totalDurationMs: number } {
    let promptTokens = 0;
    let completionTokens = 0;
    let estimatedCostUsd = 0;
    let totalCalls = 0;
    let totalDurationMs = 0;

    for (const m of this.byModel.values()) {
      promptTokens += m.totalPromptTokens;
      completionTokens += m.totalCompletionTokens;
      estimatedCostUsd += m.totalCostUsd;
      totalCalls += m.calls;
      totalDurationMs += m.totalDurationMs;
    }

    return {
      promptTokens,
      completionTokens,
      estimatedCostUsd,
      totalCalls,
      totalDurationMs,
    };
  }

  printSummary(): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const totals = this.getTotals();

    console.log("\n" + chalk.bold("═══ Arcti Metrics ═══"));
    console.log(chalk.dim(`Total time: ${elapsed}s`));
    console.log(chalk.dim(`Total LLM calls: ${totals.totalCalls}`));
    console.log(
      chalk.dim(
        `Total tokens: ${totals.promptTokens + totals.completionTokens} ` +
          `(${totals.promptTokens} prompt + ${totals.completionTokens} completion)`,
      ),
    );

    if (totals.estimatedCostUsd > 0) {
      console.log(
        chalk.dim(`Estimated cost: $${totals.estimatedCostUsd.toFixed(4)}`),
      );
    }

    console.log(chalk.bold("\nPer model:"));
    for (const [model, metrics] of this.byModel.entries()) {
      const totalTokens =
        metrics.totalPromptTokens + metrics.totalCompletionTokens;
      const avgMs = Math.round(metrics.totalDurationMs / metrics.calls);
      console.log(
        `  ${chalk.cyan(model)}: ${metrics.calls} calls, ${totalTokens} tokens, avg ${avgMs}ms` +
          (metrics.totalCostUsd > 0
            ? `, $${metrics.totalCostUsd.toFixed(4)}`
            : ""),
      );
    }
    console.log();
  }
}

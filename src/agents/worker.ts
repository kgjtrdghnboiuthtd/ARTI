import type { TaskSpec, TaskResult } from "../core/types.ts";
import { BaseAgent, type AgentContext } from "./base.ts";
import type { TaskExecutor, RetryFeedback } from "../orchestrator/scheduler.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { logger } from "../observability/logger.ts";

const WORKER_SYSTEM_PROMPT = `You are a task execution agent. Produce ONLY the raw result — nothing else.

Rules:
1. Output the RESULT directly. No introduction, no explanation, no meta-commentary.
2. NEVER write "Here is...", "I will...", "This task...", "Let me...", or any preamble.
3. NEVER describe what you did or summarize the task. Just give the answer.
4. Use provided context data directly — never ask for more.
5. Code → working code only. Text → final text only. Data → structured data only.

FORBIDDEN:
- Commentary, explanations, summaries of your process
- tool_call blocks, JSON tool invocations, simulated API calls
- Questions, file requests, shell commands
- Any text that is NOT the direct result`;

const WORKER_WITH_TOOLS_PROMPT = `You are a task execution agent with tool access.

## How to use tools
Insert ONE tool call per message as a JSON block:
\`\`\`tool_call
{"tool": "tool_name", "params": {"key": "value"}}
\`\`\`

The system will execute the tool and send you the results. Then you MUST produce the final output using those results.

TOOLS_PLACEHOLDER

## Rules
1. ONLY use tools listed above — do NOT invent tools
2. Call tools FIRST to gather data, then produce the final result
3. After receiving tool results: output ONLY the structured result — no commentary
4. NEVER output an empty response — always produce content from the tool results
5. If web_search returns results, USE them in your answer with sources

## Example flow
Step 1 — You call a tool:
\`\`\`tool_call
{"tool": "web_search", "params": {"query": "React best practices 2024"}}
\`\`\`
Step 2 — System sends results back to you
Step 3 — You produce the final structured answer using those results`;

export class WorkerAgent extends BaseAgent implements TaskExecutor {
  private tools: ToolRegistry | null;
  private log = logger.child("worker");

  constructor(ctx: AgentContext, tools?: ToolRegistry) {
    super("worker", WORKER_SYSTEM_PROMPT, ctx);
    this.tools = tools ?? null;
  }

  async execute(
    task: TaskSpec,
    model: string,
    context: string,
    retryFeedback?: RetryFeedback,
  ): Promise<TaskResult> {
    const start = performance.now();

    // Use tool-aware prompt if tools are needed and available
    const useTools =
      this.tools && task.toolsNeeded.length > 0;

    if (useTools) {
      this.systemPrompt = this.buildToolPrompt(task.toolsNeeded);
    } else {
      this.systemPrompt = WORKER_SYSTEM_PROMPT;
    }

    const prompt = this.buildPrompt(task, context, retryFeedback);
    let response = await this.call(prompt, model);

    // Process tool calls in the response (up to 5 rounds)
    let output = response.content;
    let totalTokens = { ...response.tokenUsage };

    if (useTools) {
      const toolResults: string[] = [];
      const history: LLMMessage[] = [
        { role: "user", content: prompt },
      ];

      for (let round = 0; round < 5; round++) {
        const toolCall = this.extractToolCall(output);
        if (!toolCall) break;

        this.log.debug(`Tool call round ${round + 1}: ${toolCall.tool}`, toolCall.params);

        try {
          const toolResult = await this.tools!.execute(
            toolCall.tool,
            toolCall.params,
          );
          toolResults.push(`[${toolCall.tool}] ${toolResult}`);

          // Build conversation history for multi-turn
          history.push(
            { role: "assistant", content: output },
            {
              role: "user",
              content: `Tool "${toolCall.tool}" returned:\n${toolResult}\n\nNow produce the final result using this data. Output ONLY the result, no commentary.`,
            },
          );

          // Ask model to continue with tool results
          const followUp = await this.callWithHistory(history, model);

          output = followUp.content;
          totalTokens.promptTokens += followUp.tokenUsage.promptTokens;
          totalTokens.completionTokens += followUp.tokenUsage.completionTokens;
          totalTokens.estimatedCostUsd += followUp.tokenUsage.estimatedCostUsd;
        } catch (error) {
          this.log.warn(`Tool "${toolCall.tool}" failed: ${(error as Error).message}`);
          break;
        }
      }

      // Clean any remaining tool_call blocks
      output = output.replace(/```tool_call\n[\s\S]*?```/g, "").trim();

      // CRITICAL: If model produced empty output but tools returned data,
      // use the raw tool results as fallback output
      if (!output && toolResults.length > 0) {
        this.log.warn("Model produced empty output after tool calls, using raw tool results");
        output = toolResults.join("\n\n");
      }
    } else {
      // Clean any hallucinated tool_call blocks from non-tool tasks
      output = output.replace(/```tool_call\n[\s\S]*?```/g, "").trim();
    }

    const durationMs = performance.now() - start;

    return {
      taskId: task.id,
      status: "completed",
      output,
      modelUsed: model,
      attempts: 1,
      tokenUsage: totalTokens,
      durationMs,
    };
  }

  private buildPrompt(task: TaskSpec, context: string, retryFeedback?: RetryFeedback): string {
    const complexityHint = {
      low: "Simple task — direct answer expected",
      medium: "Moderate task — requires reasoning",
      high: "Complex task — requires careful analysis",
    }[task.complexity] ?? "";

    let prompt = `[${complexityHint}]\n## Task: ${task.name}\n\n${task.description}`;

    if (task.acceptanceCriteria.length > 0) {
      prompt += `\n\n## Critères d'acceptation\n`;
      for (const c of task.acceptanceCriteria) {
        prompt += `- ${c}\n`;
      }
    }

    if (context) {
      prompt += `\n\n## Données d'entrée (résultats des tâches précédentes — utilise ces données directement, ne demande rien d'autre)\n${context}`;
    }

    // Add retry feedback so the model knows what went wrong
    if (retryFeedback) {
      prompt += `\n\n## ⚠ Tentative précédente échouée (tentative ${retryFeedback.attempt})`;
      if (retryFeedback.issues.length > 0) {
        prompt += `\n\nProblèmes identifiés :\n`;
        for (const issue of retryFeedback.issues) {
          prompt += `- ${issue}\n`;
        }
      }
      if (retryFeedback.verifierFeedback) {
        prompt += `\nFeedback du vérificateur : ${retryFeedback.verifierFeedback}`;
      }
      if (retryFeedback.previousOutput) {
        prompt += `\n\nRésultat précédent (à améliorer, NE PAS reproduire les mêmes erreurs) :\n${retryFeedback.previousOutput}`;
      }
      prompt += `\n\nIMPORTANT : Adopte une approche DIFFÉRENTE pour éviter les mêmes erreurs. Sois plus rigoureux sur les critères d'acceptation.`;
    }

    return prompt;
  }

  private buildToolPrompt(toolsNeeded: string[]): string {
    if (!this.tools) return WORKER_SYSTEM_PROMPT;

    const allTools = this.tools.list();
    const relevant = toolsNeeded.length > 0
      ? allTools.filter((t) => toolsNeeded.includes(t.name))
      : allTools;

    if (relevant.length === 0) return WORKER_SYSTEM_PROMPT;

    const toolDocs = relevant
      .map((t) => {
        const params = t.parameters
          .map((p) => `  - ${p.name} (${p.type}${p.required ? ", requis" : ""}): ${p.description}`)
          .join("\n");
        return `### ${t.name}\n${t.description}\nParamètres:\n${params}`;
      })
      .join("\n\n");

    return WORKER_WITH_TOOLS_PROMPT.replace("TOOLS_PLACEHOLDER", toolDocs);
  }

  private extractToolCall(
    text: string,
  ): { tool: string; params: Record<string, unknown> } | null {
    const match = text.match(/```tool_call\n([\s\S]*?)```/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[1]!) as {
        tool: string;
        params: Record<string, unknown>;
      };
      if (parsed.tool && parsed.params) return parsed;
    } catch {
      // Invalid JSON
    }
    return null;
  }
}

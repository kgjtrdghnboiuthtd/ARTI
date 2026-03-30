import type { TaskSpec, TaskResult, Complexity } from "../core/types.ts";
import type { ProjectState } from "../core/state.ts";
import type { EventBus } from "../core/events.ts";
import type { ModelRouter } from "../llm/router.ts";
import type { LLMClient } from "../llm/client.ts";
import { compressContext } from "../llm/compressor.ts";
import type { TaskDecomposer } from "./decomposer.ts";
import type { SkillLibrary } from "../tools/skill-library.ts";
import type { ProjectMemory } from "../core/memory.ts";
import { logger } from "../observability/logger.ts";

export interface RetryFeedback {
  attempt: number;
  previousOutput: string;
  issues: string[];
  verifierFeedback: string;
}

export interface TaskExecutor {
  execute(task: TaskSpec, model: string, context: string, retryFeedback?: RetryFeedback): Promise<TaskResult>;
}

export interface TaskVerifier {
  verify(
    task: TaskSpec,
    result: TaskResult,
  ): Promise<{
    passed: boolean;
    issues: string[];
    shouldEscalate: boolean;
    feedback: string;
  }>;
}

export class DAGScheduler {
  private state: ProjectState;
  private events: EventBus;
  private router: ModelRouter;
  private llm: LLMClient;
  private executor: TaskExecutor;
  private verifier: TaskVerifier;
  private decomposer: TaskDecomposer;
  private maxConcurrency: number;
  private maxDepth: number;
  private maxTotalTasks: number;
  private skillLibrary: SkillLibrary | null;
  private memory: ProjectMemory | null;
  private log = logger.child("scheduler");
  private processed = new Set<string>();
  private _aborted = false;

  constructor(opts: {
    state: ProjectState;
    events: EventBus;
    router: ModelRouter;
    llm: LLMClient;
    executor: TaskExecutor;
    verifier: TaskVerifier;
    decomposer: TaskDecomposer;
    maxConcurrency?: number;
    maxDepth?: number;
    maxTotalTasks?: number;
    skillLibrary?: SkillLibrary;
    memory?: ProjectMemory;
  }) {
    this.state = opts.state;
    this.events = opts.events;
    this.router = opts.router;
    this.llm = opts.llm;
    this.executor = opts.executor;
    this.verifier = opts.verifier;
    this.decomposer = opts.decomposer;
    this.maxConcurrency = opts.maxConcurrency ?? 8;
    this.maxDepth = opts.maxDepth ?? 10;
    this.maxTotalTasks = opts.maxTotalTasks ?? 500;
    this.skillLibrary = opts.skillLibrary ?? null;
    this.memory = opts.memory ?? null;
  }

  async run(tasks: TaskSpec[]): Promise<TaskResult[]> {
    this.state.addTasks(tasks);

    // Initialize pending results for new tasks
    for (const task of tasks) {
      if (!this.state.results.has(task.id)) {
        this.state.setResult({
          taskId: task.id,
          status: "pending",
          output: "",
          modelUsed: "",
          attempts: 0,
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            estimatedCostUsd: 0,
          },
          durationMs: 0,
        });
      }
    }

    // Listen for redo requests — remove task from processed set so it can re-run
    this.events.on("task:redo", (data) => {
      const { taskId } = data as { taskId: string; feedback: string };
      this.processed.delete(taskId);
      this.log.info(`Task "${taskId}" re-queued for redo`);
    });

    // Main scheduling loop
    let iterations = 0;
    const maxIterations = this.maxTotalTasks * 3; // Safety valve (higher for redos)

    while (iterations++ < maxIterations) {
      if (this._aborted) {
        this.log.warn("Run aborted by user");
        break;
      }

      const runnable = this.getReadyTasks();

      // If no runnable tasks, wait briefly for potential redo requests before exiting
      if (runnable.length === 0) {
        // Check if there are any pending tasks (might be waiting for redo)
        const hasPending = Array.from(this.state.results.values()).some(r => r.status === "pending");
        if (!hasPending) break;

        // Wait up to 2s for a redo request, then check again
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retryRunnable = this.getReadyTasks();
        if (retryRunnable.length === 0) break;
        // Continue loop with the newly available tasks
        continue;
      }

      const batch = runnable.slice(0, this.maxConcurrency);
      this.log.info(`Batch: ${batch.map((t) => t.name).join(", ")}`);

      // Mark all as being processed before awaiting
      for (const t of batch) this.processed.add(t.id);

      await Promise.all(batch.map((task) => this.processTask(task)));
    }

    return Array.from(this.state.results.values());
  }

  /** Abort the current run */
  abort(): void {
    this._aborted = true;
  }

  get aborted(): boolean {
    return this._aborted;
  }

  /** Get tasks that are ready to run and haven't been processed yet */
  private getReadyTasks(): TaskSpec[] {
    return Array.from(this.state.tasks.values()).filter((task) => {
      // Already handled
      if (this.processed.has(task.id)) return false;

      // Check result status
      const result = this.state.results.get(task.id);
      if (!result || result.status !== "pending") return false;

      // All dependencies satisfied
      return task.dependsOn.every((depId) => {
        const depResult = this.state.results.get(depId);
        return depResult?.status === "verified";
      });
    });
  }

  private async processTask(task: TaskSpec): Promise<void> {
    if (this._aborted) return;

    if (!task.isAtomic) {
      await this.decomposeTask(task);
    } else {
      await this.executeWithVerification(task);
    }
  }

  /** Get dependency outputs, compressing if above threshold */
  private async getContext(taskId: string): Promise<string> {
    const raw = this.state.getTaskDependencyOutputs(taskId).join("\n---\n");
    if (!raw) return "";
    const compressModel = this.router.select("low");
    return compressContext(raw, compressModel, this.llm);
  }

  private async decomposeTask(task: TaskSpec): Promise<void> {
    // Hit depth limit → force atomic execution
    if (task.depth >= this.maxDepth) {
      this.log.warn(`Max depth for "${task.name}", forcing atomic`);
      task.isAtomic = true;
      await this.executeWithVerification(task);
      return;
    }

    // Hit total task limit → force atomic execution
    if (this.state.getTaskCount() >= this.maxTotalTasks) {
      this.log.warn(`Max tasks reached, forcing atomic for "${task.name}"`);
      task.isAtomic = true;
      await this.executeWithVerification(task);
      return;
    }

    this.log.info(`Decomposing "${task.name}" (depth ${task.depth})`);

    const decompModel = this.router.select(
      task.depth === 0 ? "high" : "medium",
    );

    const context = await this.getContext(task.id);

    try {
      const subTasks = await this.decomposer.subDecompose(
        task,
        context,
        decompModel,
      );

      // Register sub-tasks in state
      task.children = subTasks.map((t) => t.id);
      this.state.addTasks(subTasks);

      // Initialize results for new sub-tasks
      for (const st of subTasks) {
        this.state.setResult({
          taskId: st.id,
          status: "pending",
          output: "",
          modelUsed: "",
          attempts: 0,
          tokenUsage: {
            promptTokens: 0,
            completionTokens: 0,
            estimatedCostUsd: 0,
          },
          durationMs: 0,
        });
      }

      // Mark parent as done (decomposed)
      this.state.setResult({
        taskId: task.id,
        status: "verified",
        output: `Decomposed into ${subTasks.length} sub-tasks: ${subTasks.map((t) => t.name).join(", ")}`,
        modelUsed: decompModel,
        attempts: 1,
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
        },
        durationMs: 0,
      });

      await this.events.emit("task:decomposed", {
        parentId: task.id,
        children: subTasks,
      });
    } catch (error) {
      this.log.error(`Decomposition failed for "${task.name}", forcing atomic`);
      task.isAtomic = true;
      await this.executeWithVerification(task);
    }
  }

  private async executeWithVerification(task: TaskSpec): Promise<void> {
    let currentComplexity: Complexity = task.complexity;
    let lastFeedback: RetryFeedback | undefined;
    let lastResult: TaskResult | undefined;

    // Cache compressed context before the retry loop so it's computed once
    let context = await this.getContext(task.id);

    // Inject relevant memory patterns as hints
    if (this.memory) {
      const patterns = this.memory.getPatterns(30);
      if (patterns.length > 0) {
        // Score patterns by keyword relevance to this task
        const keywords = task.description
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        const relevant = patterns
          .map((p) => {
            const text = p.content.toLowerCase();
            const matchCount = keywords.filter((k) => text.includes(k)).length;
            return { pattern: p, score: matchCount * 20 + p.confidence };
          })
          .filter((s) => s.score > 30)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);

        if (relevant.length > 0) {
          const memoryHint = "\n\n## Lessons learned\n" + relevant.map((r) => `- ${r.pattern.content}`).join("\n");
          context += memoryHint;
        }
      }
    }

    for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
      // Only escalate when the verifier explicitly requests it (via currentComplexity)
      const model = this.router.select(currentComplexity);

      this.log.info(
        `Exec "${task.name}" (attempt ${attempt + 1}/${task.maxRetries + 1}, ${model}${attempt > 0 ? " — retrying with feedback" : ""})`,
      );

      this.state.setResult({
        taskId: task.id,
        status: "running",
        output: "",
        modelUsed: model,
        attempts: attempt + 1,
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
        },
        durationMs: 0,
      });

      await this.events.emit("task:started", { taskId: task.id, model });

      try {
        const result = await this.executor.execute(task, model, context, lastFeedback);

        // Skip LLM verification for low-complexity tasks (auto-pass if output is non-empty)
        if (task.complexity === "low" && result.output.trim().length > 0) {
          const autoVerdict = { passed: true, issues: [], shouldEscalate: false, feedback: "" };
          const verified: TaskResult = { ...result, status: "verified", verification: autoVerdict };
          this.state.setResult(verified);
          await this.events.emit("task:verified", { taskId: task.id, result: autoVerdict });
          await this.events.emit("task:completed", verified);
          this.log.info(`"${task.name}" auto-verified (low complexity)`);
          this.registerAsSkill(task, verified, autoVerdict);
          return;
        }

        // Full LLM verification for medium/high complexity tasks
        const verdict = await this.verifier.verify(task, result);

        await this.events.emit("task:verified", {
          taskId: task.id,
          result: verdict,
        });

        // Score skills used by this task
        this.scoreTaskSkills(task, result, verdict);

        if (verdict.passed) {
          const verified: TaskResult = {
            ...result,
            status: "verified",
            verification: verdict,
          };
          this.state.setResult(verified);
          await this.events.emit("task:completed", verified);
          this.log.info(`"${task.name}" verified`);

          // Auto-register verified atomic tasks as skills
          this.registerAsSkill(task, verified, verdict);

          return;
        }

        this.log.warn(`"${task.name}" failed verification: ${verdict.issues.join("; ")}`);

        // Build feedback for next attempt
        lastFeedback = {
          attempt: attempt + 1,
          previousOutput: result.output.slice(0, 2000), // limit to avoid huge prompts
          issues: verdict.issues,
          verifierFeedback: verdict.feedback,
        };
        lastResult = result;

        // Escalate complexity if verifier recommends it
        if (verdict.shouldEscalate) {
          const next = this.router.nextTier(currentComplexity);
          if (next) {
            this.log.info(`Escalating "${task.name}" from ${currentComplexity} to ${next}`);
            currentComplexity = next;
          }
        }
      } catch (error) {
        const errMsg = (error as Error).message;
        this.log.error(`"${task.name}" error: ${errMsg}`);

        // Build feedback from the error itself
        lastFeedback = {
          attempt: attempt + 1,
          previousOutput: "",
          issues: [`Execution error: ${errMsg}`],
          verifierFeedback: "The previous attempt crashed. Try a different approach.",
        };

        // Always escalate on crash
        const next = this.router.nextTier(currentComplexity);
        if (next) currentComplexity = next;
      }
    }

    // All retries exhausted
    const failed: TaskResult = {
      taskId: task.id,
      status: "failed",
      output: lastResult?.output ?? "Max retries exhausted",
      modelUsed: this.router.select(currentComplexity),
      attempts: task.maxRetries + 1,
      tokenUsage: lastResult?.tokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
      },
      durationMs: lastResult?.durationMs ?? 0,
    };
    this.state.setResult(failed);
    await this.events.emit("task:failed", failed);
    this.log.error(`"${task.name}" failed after ${task.maxRetries + 1} attempts`);
  }

  /** Auto-register a verified task as a reusable skill */
  private registerAsSkill(
    task: TaskSpec,
    result: TaskResult,
    verdict: { passed: boolean; issues: string[] },
  ): void {
    if (!this.skillLibrary) return;
    // Only register atomic leaf tasks (not decomposed parents)
    if (!task.isAtomic) return;

    // Create a skill name from the task
    const skillName = task.name
      .toLowerCase()
      .replace(/[^a-zà-ÿ0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60);

    const existing = this.skillLibrary.get(skillName);

    if (existing) {
      // Skill exists — just record this execution
      this.skillLibrary.recordExecution(skillName, {
        passed: verdict.passed,
        issues: verdict.issues,
        durationMs: result.durationMs,
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
      });
    } else {
      // New skill — save it
      this.skillLibrary.save({
        name: skillName,
        description: task.description,
        parameters: [],
        code: "", // no code — this is a prompt-based skill
      });
      // Record the first execution
      this.skillLibrary.recordExecution(skillName, {
        passed: true,
        issues: [],
        durationMs: result.durationMs,
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
      });
      this.log.info(`Registered new skill: "${skillName}" (score: ${this.skillLibrary.get(skillName)?.meta.score})`);
    }
  }

  /** Record execution results for any skills (tools) used by the task */
  private scoreTaskSkills(
    task: TaskSpec,
    result: TaskResult,
    verdict: { passed: boolean; issues: string[] },
  ): void {
    if (!this.skillLibrary || task.toolsNeeded.length === 0) return;

    for (const toolName of task.toolsNeeded) {
      // Only score skills that exist in the library (skip builtins)
      if (!this.skillLibrary.get(toolName)) continue;

      this.skillLibrary.recordExecution(toolName, {
        passed: verdict.passed,
        issues: verdict.issues,
        durationMs: result.durationMs,
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
      });
    }
  }
}

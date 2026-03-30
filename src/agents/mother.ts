import type { ProjectBrief, TaskResult } from "../core/types.ts";
import { BaseAgent, type AgentContext } from "./base.ts";
import { IntakeAgent } from "../orchestrator/intake.ts";
import { TaskDecomposer } from "../orchestrator/decomposer.ts";
import { DAGScheduler } from "../orchestrator/scheduler.ts";
import { WorkerAgent } from "./worker.ts";
import { VerifierAgent } from "./verifier.ts";
import type { ProjectState } from "../core/state.ts";
import type { ModelRouter } from "../llm/router.ts";
import type { ArctiConfig, ProviderName } from "../config.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { SkillLibrary } from "../tools/skill-library.ts";
import type { ProjectMemory } from "../core/memory.ts";
import { CodeSandbox } from "../core/sandbox.ts";
import { logger } from "../observability/logger.ts";
import chalk from "chalk";

const SYNTH_SYSTEM_PROMPT = `Assemble task results into ONE final deliverable. Output the RESULT only.

RULES:
1. Combine all task outputs into a single coherent result
2. Output ONLY the final deliverable — zero commentary, zero meta-text
3. NEVER write "Here are the results", "The tasks produced", "In summary" or ANY preamble
4. Code → use \`\`\`lang#filename.ext format for each file, include ALL code
5. Text → output the final text directly
6. Data/research → structured output with findings
7. Fix inconsistencies between tasks silently — just output the corrected result`;

export class MotherAgent extends BaseAgent {
  private state: ProjectState;
  private router: ModelRouter;
  private config: ArctiConfig;
  private tools: ToolRegistry | null;
  private skillLibrary: SkillLibrary | null;
  private memory: ProjectMemory | null;
  private sandbox: CodeSandbox;
  private overrideProvider?: ProviderName;
  private log = logger.child("mother");
  private currentScheduler: DAGScheduler | null = null;
  private _running = false;

  constructor(
    ctx: AgentContext,
    state: ProjectState,
    router: ModelRouter,
    config: ArctiConfig,
    tools?: ToolRegistry,
    overrideProvider?: ProviderName,
    skillLibrary?: SkillLibrary,
    memory?: ProjectMemory,
  ) {
    super("mother", SYNTH_SYSTEM_PROMPT, ctx);
    this.state = state;
    this.router = router;
    this.config = config;
    this.tools = tools ?? null;
    this.skillLibrary = skillLibrary ?? null;
    this.memory = memory ?? null;
    this.sandbox = new CodeSandbox();
    this.overrideProvider = overrideProvider;
  }

  /**
   * Phase 1: Adaptive intake — analyze user input and ask targeted questions.
   */
  async intake(
    userInput: string,
    askQuestion: (questions: string[]) => Promise<string>,
  ): Promise<ProjectBrief> {
    this.log.info("Starting intake phase");
    await this.ctx.events.emit("project:intake-start", undefined as never);

    const intakeAgent = new IntakeAgent(this.ctx);
    const model = this.router.select("high", 0, this.overrideProvider);

    let result = await intakeAgent.analyze(userInput, model);

    // Interactive loop: ask questions until we have enough info (max 2 rounds)
    const MAX_CLARIFICATION_ROUNDS = 2;
    let round = 0;
    while (result.needsMore && round < MAX_CLARIFICATION_ROUNDS) {
      round++;
      this.log.info(`Clarification round ${round}/${MAX_CLARIFICATION_ROUNDS} — ${result.questions.length} questions`);

      console.log(chalk.yellow("\n? Questions de clarification :"));
      for (const [i, q] of result.questions.entries()) {
        console.log(chalk.yellow(`  ${i + 1}. ${q}`));
      }

      const answers = await askQuestion(result.questions);
      result = await intakeAgent.refine(answers, model);
    }

    if (result.needsMore) {
      this.log.warn("Max clarification rounds reached, proceeding with available info");
    }

    // If we hit the limit without a brief, build a minimal one from the input
    const brief: ProjectBrief = result.brief ?? {
      objective: userInput,
      targetAudience: "",
      constraints: [],
      rawUserInput: userInput,
    };
    this.state.brief = brief;
    await this.ctx.events.emit("project:intake-done", brief);

    this.log.info("Intake complete", { objective: brief.objective });
    return brief;
  }

  /**
   * Phase 2: Decompose project into DAG of tasks (recursive).
   */
  async decompose(brief: ProjectBrief): Promise<void> {
    this.log.info("Starting task decomposition");

    // Retrieve context from past projects if memory is available
    let memoryContext: string | undefined;
    if (this.memory) {
      memoryContext = this.memory.getRelevantContext(brief.objective);
      if (memoryContext && memoryContext !== "No relevant memories found.") {
        this.log.info("Injecting memory context into decomposition");
      }
    }

    const decomposer = new TaskDecomposer(this.ctx, this.skillLibrary ?? undefined);
    const model = this.router.select("high", 0, this.overrideProvider);

    const tasks = await decomposer.decompose(brief, model, memoryContext);

    this.log.info(`Created ${tasks.length} top-level tasks`);
    this.printTaskTree(tasks);

    // Add tasks to state — scheduler will handle recursive decomposition
    this.state.addTasks(tasks);
  }

  /**
   * Phase 3: Execute all tasks via DAG scheduler.
   */
  async execute(): Promise<TaskResult[]> {
    this.log.info("Starting execution phase");

    const worker = new WorkerAgent(this.ctx, this.tools ?? undefined);
    const verifier = new VerifierAgent(this.ctx, this.sandbox);
    const decomposer = new TaskDecomposer(this.ctx, this.skillLibrary ?? undefined);

    this.currentScheduler = new DAGScheduler({
      state: this.state,
      events: this.ctx.events,
      router: this.router,
      llm: this.ctx.llm,
      executor: worker,
      verifier,
      decomposer,
      maxConcurrency: this.config.scheduler.maxConcurrency,
      maxDepth: this.config.recursion.maxDepth,
      maxTotalTasks: this.config.recursion.maxTotalTasks,
      skillLibrary: this.skillLibrary ?? undefined,
      memory: this.memory ?? undefined,
    });

    const tasks = Array.from(this.state.tasks.values());
    const results = await this.currentScheduler.run(tasks);
    this.currentScheduler = null;

    this.log.info("Execution complete", {
      total: results.length,
      verified: results.filter((r) => r.status === "verified").length,
      failed: results.filter((r) => r.status === "failed").length,
    });

    return results;
  }

  /**
   * Phase 4: Synthesize all results into final output.
   */
  async synthesize(results: TaskResult[]): Promise<string> {
    this.log.info("Starting synthesis phase");

    const verified = results.filter(
      (r) => r.status === "verified" && r.output && !r.output.startsWith("Decomposed"),
    );

    if (verified.length === 0) {
      return "Aucune tâche n'a été complétée avec succès.";
    }

    // If only one result, return it directly
    if (verified.length === 1) {
      return verified[0]!.output;
    }

    const model = this.router.select("medium", 0, this.overrideProvider);

    const taskOutputs = verified
      .map((r) => {
        const task = this.state.tasks.get(r.taskId);
        return `### ${task?.name ?? r.taskId}\n${r.output}`;
      })
      .join("\n\n---\n\n");

    const prompt = `Objective: ${this.state.brief?.objective ?? "unknown"}

TASK RESULTS:
${taskOutputs}

Assemble these results into ONE final deliverable. Output ONLY the result — no commentary, no preamble, no "here is the result". Code uses \`\`\`lang#file.ext format.`;

    const response = await this.call(prompt, model);

    const totalTokens = this.state.getTotalTokenUsage();
    await this.ctx.events.emit("project:complete", {
      results,
      totalTokens,
    });

    return response.content;
  }

  /**
   * Run the full pipeline: intake → decompose → execute → synthesize.
   */
  /** Abort the current run */
  abort(): void {
    if (this.currentScheduler) {
      this.currentScheduler.abort();
    }
    this._running = false;
    this.log.warn("Run aborted by user");
  }

  get running(): boolean {
    return this._running;
  }

  async run(
    userInput: string,
    askQuestion: (questions: string[]) => Promise<string>,
  ): Promise<string> {
    this._running = true;

    // Phase 1: Intake
    const brief = await this.intake(userInput, askQuestion);

    console.log(chalk.green("\n✓ Brief du projet :"));
    console.log(chalk.dim(`  Objectif : ${brief.objective}`));
    if (brief.targetAudience)
      console.log(chalk.dim(`  Audience : ${brief.targetAudience}`));
    if (brief.constraints.length > 0)
      console.log(chalk.dim(`  Contraintes : ${brief.constraints.join(", ")}`));

    // Phase 2: Decompose
    await this.decompose(brief);

    // Phase 3: Execute
    const results = await this.execute();

    // Phase 4: Synthesize
    const finalOutput = await this.synthesize(results);

    this._running = false;
    return finalOutput;
  }

  private printTaskTree(tasks: { name: string; isAtomic: boolean; complexity: string; depth: number }[]): void {
    for (const task of tasks) {
      const indent = "  ".repeat(task.depth);
      const icon = task.isAtomic ? "●" : "◆";
      const color = task.isAtomic ? chalk.green : chalk.yellow;
      console.log(
        `${indent}${color(icon)} ${task.name} ${chalk.dim(`[${task.complexity}]`)}`,
      );
    }
  }
}

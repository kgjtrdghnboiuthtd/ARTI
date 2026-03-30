import { EventBus } from "./events.ts";
import { ProjectState } from "./state.ts";
import { MotherAgent } from "../agents/mother.ts";
import { MetricsCollector } from "../observability/metrics.ts";
import type { LLMClient } from "../llm/client.ts";
import type { ModelRouter } from "../llm/router.ts";
import type { ArctiConfig, ProviderName } from "../config.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { SkillLibrary } from "../tools/skill-library.ts";
import type { ProjectMemory } from "./memory.ts";
import { writeFinalOutput } from "./artifact-writer.ts";
import { logger } from "../observability/logger.ts";
import type { ProjectBrief, TaskSpec, TaskResult } from "./types.ts";

export interface RunOptions {
  provider?: ProviderName;
  workDir?: string;
  source?: string;
}

export interface ProjectRun {
  id: string;
  name: string;
  input: string;
  status: "running" | "completed" | "failed" | "aborted";
  provider: ProviderName;
  workDir: string | null;
  artifacts: string[];
  createdAt: number;
  state: ProjectState;
  events: EventBus;
  metrics: MetricsCollector;
  mother: MotherAgent;
}

const log = logger.child("run-manager");

export class RunManager {
  private runs = new Map<string, ProjectRun>();
  private config: ArctiConfig;
  private llm: LLMClient;
  private router: ModelRouter;
  private tools: ToolRegistry;
  private skillLibrary: SkillLibrary | null;
  private memory: ProjectMemory | null;
  /** Global event bus for broadcasting to WebSocket (all projects) */
  readonly globalEvents: EventBus;
  /** Pending intake question resolvers — projectId → resolve function */
  private pendingAnswers = new Map<string, (answer: string) => void>();
  /** Pending task feedback resolvers — `${projectId}:${taskId}` → resolve function */
  private pendingTaskFeedback = new Map<string, (feedback: string) => void>();

  constructor(opts: {
    config: ArctiConfig;
    llm: LLMClient;
    router: ModelRouter;
    tools: ToolRegistry;
    globalEvents: EventBus;
    skillLibrary?: SkillLibrary;
    memory?: ProjectMemory;
  }) {
    this.config = opts.config;
    this.llm = opts.llm;
    this.router = opts.router;
    this.tools = opts.tools;
    this.globalEvents = opts.globalEvents;
    this.skillLibrary = opts.skillLibrary ?? null;
    this.memory = opts.memory ?? null;
  }

  /** Get the skill library */
  getSkillLibrary(): SkillLibrary | null { return this.skillLibrary; }

  /** Get the current config (for settings API) */
  getConfig(): ArctiConfig { return this.config; }

  /** Update the config at runtime */
  setConfig(config: ArctiConfig): void { this.config = config; }

  /** Get the LLM client */
  getLLMClient(): LLMClient { return this.llm; }

  /** Get the model router */
  getRouter(): ModelRouter { return this.router; }

  /** Create and start a new project run */
  createRun(input: string, opts?: RunOptions): ProjectRun {
    const id = crypto.randomUUID().slice(0, 8);
    const name = input.slice(0, 50) + (input.length > 50 ? "..." : "");
    const provider = opts?.provider ?? this.config.defaultProvider;
    let workDir = opts?.workDir ?? null;
    // Resolve ~ to home directory
    if (workDir?.startsWith("~")) {
      workDir = workDir.replace(/^~/, process.env.HOME ?? "/tmp");
    }

    const events = new EventBus();
    const state = new ProjectState();
    state.events = events;

    const metrics = new MetricsCollector();
    metrics.attach(events);

    const mother = new MotherAgent(
      { llm: this.llm, events },
      state,
      this.router,
      this.config,
      this.tools,
      provider,
      this.skillLibrary ?? undefined,
      this.memory ?? undefined,
    );

    const run: ProjectRun = {
      id,
      name,
      input,
      status: "running",
      provider,
      workDir,
      artifacts: [],
      createdAt: Date.now(),
      state,
      events,
      metrics,
      mother,
    };

    this.runs.set(id, run);

    // Forward all project events to global bus with projectId
    this.forwardEvents(run);

    // Notify dashboard of new project
    this.globalEvents.emit("project:created", {
      projectId: id,
      name,
      provider,
      workDir,
      source: opts?.source ?? "dashboard",
    } as any);

    log.info("Created run", { id, name });
    return run;
  }

  /** Answer pending intake questions for a project */
  answerQuestions(projectId: string, answer: string): boolean {
    const resolver = this.pendingAnswers.get(projectId);
    if (!resolver) return false;

    resolver(answer);
    this.pendingAnswers.delete(projectId);
    log.info("Intake answer received", { projectId });
    return true;
  }

  /** Check if a project has pending questions */
  hasPendingQuestions(projectId: string): boolean {
    return this.pendingAnswers.has(projectId);
  }

  /** Submit user feedback for a task during execution */
  submitTaskFeedback(projectId: string, taskId: string, feedback: string): boolean {
    const key = `${projectId}:${taskId}`;
    const resolver = this.pendingTaskFeedback.get(key);
    if (!resolver) return false;

    resolver(feedback);
    this.pendingTaskFeedback.delete(key);
    log.info("Feedback reçu pour la tâche", { projectId, taskId });
    return true;
  }

  /** Mark a verified or failed task for re-execution with user feedback */
  requestTaskRedo(projectId: string, taskId: string, feedback: string): boolean {
    const run = this.runs.get(projectId);
    if (!run) return false;

    const task = run.state.tasks.get(taskId);
    if (!task) return false;

    const result = run.state.results.get(taskId);
    if (!result || (result.status !== "verified" && result.status !== "failed")) return false;

    // Reset the task result to pending so it becomes runnable again
    run.state.setResult({
      taskId,
      status: "pending",
      output: "",
      modelUsed: "",
      attempts: 0,
      tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
      durationMs: 0,
    });

    // Emit redo event — scheduler listens for this to re-queue the task
    run.events.emit("task:redo", { taskId, feedback });
    log.info("Redo demandé pour la tâche", { projectId, taskId, feedback });
    return true;
  }

  /** Check if a task has pending feedback */
  hasPendingTaskFeedback(projectId: string, taskId: string): boolean {
    return this.pendingTaskFeedback.has(`${projectId}:${taskId}`);
  }

  /** Register a pending feedback request for a task (used by agents) */
  registerTaskFeedbackRequest(projectId: string, taskId: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const key = `${projectId}:${taskId}`;
      this.pendingTaskFeedback.set(key, resolve);

      // Auto-skip après 5 min si pas de réponse
      setTimeout(() => {
        if (this.pendingTaskFeedback.has(key)) {
          this.pendingTaskFeedback.delete(key);
          log.warn("Feedback tâche expiré, continuation automatique", { projectId, taskId });
          resolve("Continuer sans modification.");
        }
      }, 5 * 60 * 1000);
    });
  }

  /** Start executing a run */
  startRun(run: ProjectRun): void {
    run.mother
      .run(run.input, async (questions) => {
        log.info("Intake questions for user", { id: run.id, questions });

        // Emit questions to frontend via WebSocket
        await run.events.emit("project:intake-questions", { questions });

        // Wait for user answer (or timeout after 5 minutes)
        return new Promise<string>((resolve) => {
          this.pendingAnswers.set(run.id, resolve);

          // Auto-skip after 5 min if no answer
          setTimeout(() => {
            if (this.pendingAnswers.has(run.id)) {
              this.pendingAnswers.delete(run.id);
              log.warn("Intake questions timed out, auto-skipping", { id: run.id });
              resolve("Continue avec les informations disponibles.");
            }
          }, 5 * 60 * 1000);
        });
      })
      .then((finalOutput) => {
        run.status = "completed";

        // Write artifacts to workDir if specified
        if (run.workDir && finalOutput) {
          try {
            const taskOutputs = new Map<string, { name: string; output: string }>();
            for (const [id, result] of run.state.results) {
              const task = run.state.tasks.get(id);
              if (result.status === "verified" && result.output) {
                taskOutputs.set(id, { name: task?.name ?? id, output: result.output });
              }
            }
            run.artifacts = writeFinalOutput(run.workDir, finalOutput, taskOutputs);
            log.info("Artifacts written", { id: run.id, count: run.artifacts.length, dir: run.workDir });
          } catch (err) {
            log.error("Failed to write artifacts", { id: run.id, error: (err as Error).message });
          }
        }

        // Extract learnings into project memory
        if (this.memory && run.state.brief) {
          try {
            const results = Array.from(run.state.results.values());
            this.memory.extractLearnings(run.state.brief, results, run.state.tasks);
            this.memory.save().catch((err) => {
              log.error("Failed to save memory", { id: run.id, error: (err as Error).message });
            });
            log.info("Memory learnings extracted", { id: run.id });
          } catch (err) {
            log.error("Failed to extract learnings", { id: run.id, error: (err as Error).message });
          }
        }

        log.info("Run completed", { id: run.id });
      })
      .catch((err) => {
        run.status = run.mother.running ? "failed" : "aborted";
        log.error("Run ended", { id: run.id, status: run.status, error: (err as Error).message });
      });
  }

  /** Stop a running project */
  stopRun(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || !run.mother.running) return false;

    run.mother.abort();
    run.status = "aborted";
    run.events.emit("project:aborted", { reason: "User requested stop" });
    log.info("Run aborted", { id });
    return true;
  }

  /** Get a run by ID */
  getRun(id: string): ProjectRun | undefined {
    return this.runs.get(id);
  }

  /** List all runs (newest first) */
  listRuns(): ProjectRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Import a previously exported project as a read-only replay */
  importRun(data: {
    name: string;
    input: string;
    provider: ProviderName;
    workDir: string | null;
    status: string;
    brief: ProjectBrief | null;
    tasks: TaskSpec[];
    results: TaskResult[];
  }): ProjectRun {
    const id = crypto.randomUUID().slice(0, 8);
    const events = new EventBus();
    const state = new ProjectState();
    state.events = events;

    // Populate brief
    if (data.brief) {
      state.brief = data.brief;
    }

    // Populate tasks
    for (const task of data.tasks) {
      state.addTask(task);
    }

    // Populate results (all marked as their original status)
    for (const result of data.results) {
      state.setResult(result);
    }

    const metrics = new MetricsCollector();
    // No need to attach to events — this is a static import

    const mother = new MotherAgent(
      { llm: this.llm, events },
      state,
      this.router,
      this.config,
      this.tools,
      data.provider,
      this.skillLibrary ?? undefined,
      this.memory ?? undefined,
    );

    const run: ProjectRun = {
      id,
      name: data.name,
      input: data.input,
      status: "completed",
      provider: data.provider,
      workDir: data.workDir,
      artifacts: [],
      createdAt: Date.now(),
      state,
      events,
      metrics,
      mother,
    };

    this.runs.set(id, run);

    // Forward events so it shows up in WebSocket broadcasts
    this.forwardEvents(run);

    log.info("Imported run", { id, name: data.name, tasks: data.tasks.length });
    return run;
  }

  /** Delete a run */
  deleteRun(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    if (run.mother.running) run.mother.abort();
    this.runs.delete(id);
    return true;
  }

  /** Forward per-project events to global WebSocket bus with projectId */
  private forwardEvents(run: ProjectRun): void {
    const eventNames = [
      "task:created",
      "task:started",
      "task:completed",
      "task:failed",
      "task:verified",
      "task:decomposed",
      "task:stream-chunk",
      "task:feedback-request",
      "task:user-feedback",
      "project:intake-start",
      "project:intake-questions",
      "project:intake-done",
      "project:complete",
      "project:aborted",
      "llm:call",
      "llm:response",
    ] as const;

    for (const event of eventNames) {
      run.events.on(event, (data: unknown) => {
        // Emit on global bus with projectId injected
        this.globalEvents.emit(event as any, {
          ...(typeof data === "object" && data !== null ? data : {}),
          projectId: run.id,
        } as any);
      });
    }
  }
}

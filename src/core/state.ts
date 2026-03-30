import type {
  ProjectBrief,
  TaskSpec,
  TaskResult,
  TokenUsage,
} from "./types.ts";
import { EventBus } from "./events.ts";

export class ProjectState {
  brief: ProjectBrief | null = null;
  tasks = new Map<string, TaskSpec>();
  results = new Map<string, TaskResult>();
  events = new EventBus();

  addTask(task: TaskSpec): void {
    this.tasks.set(task.id, task);
  }

  addTasks(tasks: TaskSpec[]): void {
    for (const t of tasks) this.addTask(t);
  }

  setResult(result: TaskResult): void {
    this.results.set(result.taskId, result);
  }

  getTaskDependencyOutputs(taskId: string): string[] {
    const task = this.tasks.get(taskId);
    if (!task) return [];

    return task.dependsOn
      .map((depId) => this.results.get(depId))
      .filter((r): r is TaskResult => r !== undefined && r.status === "verified")
      .map((r) => r.output)
      .filter((output) => !output.startsWith("Decomposed into ")); // Skip decomposition markers
  }

  getRunnableTasks(): TaskSpec[] {
    return Array.from(this.tasks.values()).filter((task) => {
      const result = this.results.get(task.id);
      if (result && result.status !== "pending") return false;

      return task.dependsOn.every((depId) => {
        const depResult = this.results.get(depId);
        return depResult?.status === "verified";
      });
    });
  }

  getTotalTokenUsage(): TokenUsage {
    let promptTokens = 0;
    let completionTokens = 0;
    let estimatedCostUsd = 0;

    for (const result of this.results.values()) {
      promptTokens += result.tokenUsage.promptTokens;
      completionTokens += result.tokenUsage.completionTokens;
      estimatedCostUsd += result.tokenUsage.estimatedCostUsd;
    }

    return { promptTokens, completionTokens, estimatedCostUsd };
  }

  getTaskCount(): number {
    return this.tasks.size;
  }

  getMaxDepth(): number {
    let max = 0;
    for (const task of this.tasks.values()) {
      if (task.depth > max) max = task.depth;
    }
    return max;
  }

  isComplete(): boolean {
    for (const task of this.tasks.values()) {
      if (!task.isAtomic) continue; // Non-atomic tasks are decomposed, not executed
      const result = this.results.get(task.id);
      if (!result || (result.status !== "verified" && result.status !== "failed"))
        return false;
    }
    return true;
  }
}

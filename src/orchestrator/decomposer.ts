import type { TaskSpec, ProjectBrief } from "../core/types.ts";
import { BaseAgent, type AgentContext } from "../agents/base.ts";
import { randomUUID } from "crypto";
import type { SkillLibrary } from "../tools/skill-library.ts";

const DECOMPOSE_SYSTEM_PROMPT = `Décompose un projet en tâches. JSON uniquement.
{"tasks":[{"name":"","description":"","complexity":"low|medium|high","isAtomic":bool,"dependsOn":[],"acceptanceCriteria":[],"toolsNeeded":[]}]}

Règles :
- isAtomic=true si réalisable en 1 étape, false si trop complexe (sera redécoupée)
- dependsOn = noms des tâches prérequises dans cette liste
- complexity: low=formatage/extraction, medium=raisonnement/rédaction, high=architecture/code
- 3-10 tâches, privilégie la granularité fine plutôt que peu de grosses tâches
- toolsNeeded parmi: read_file, write_file, list_dir, shell, fetch_url, web_search, eval_code`;

const SUB_DECOMPOSE_PROMPT = `Découpe une tâche en sous-tâches plus petites. JSON uniquement.
{"tasks":[{"name":"","description":"","complexity":"low|medium|high","isAtomic":bool,"dependsOn":[],"acceptanceCriteria":[],"toolsNeeded":[]}]}

Règles :
- 2-5 sous-tâches
- isAtomic=true si la sous-tâche est simple et réalisable en 1 étape
- isAtomic=false si la sous-tâche est encore trop complexe et doit être redécoupée
- Chaque sous-tâche doit être PLUS SIMPLE que la tâche parent
- dependsOn = noms dans cette liste
- toolsNeeded parmi: read_file, write_file, list_dir, shell, fetch_url, web_search, eval_code`;

interface DecomposeResponse {
  tasks: Array<{
    name: string;
    description: string;
    complexity: "low" | "medium" | "high";
    isAtomic: boolean;
    dependsOn: string[];
    acceptanceCriteria: string[];
    toolsNeeded: string[];
  }>;
}

export class TaskDecomposer extends BaseAgent {
  private skillLibrary: SkillLibrary | null;

  constructor(ctx: AgentContext, skillLibrary?: SkillLibrary) {
    super("decomposer", DECOMPOSE_SYSTEM_PROMPT, ctx);
    this.skillLibrary = skillLibrary ?? null;
  }

  /**
   * Initial decomposition of a project brief into top-level tasks.
   */
  async decompose(brief: ProjectBrief, model: string, memoryContext?: string): Promise<TaskSpec[]> {
    const skillHint = this.getSkillHint(brief.objective);
    const memoryHint = memoryContext && memoryContext !== "No relevant memories found."
      ? `\n\nContexte des projets précédents :\n${memoryContext}`
      : "";

    const prompt = `Décompose ce projet en tâches :

Objectif : ${brief.objective}
Audience : ${brief.targetAudience}
Contraintes : ${brief.constraints.join(", ") || "aucune"}
Critères de succès : ${brief.successCriteria.join(", ") || "non définis"}
${brief.motivation ? `Motivation : ${brief.motivation}` : ""}
${brief.timeline ? `Timeline : ${brief.timeline}` : ""}${skillHint}${memoryHint}`;

    const { parsed } = await this.callJSON<DecomposeResponse>(prompt, model);

    return this.buildTaskSpecs(parsed.tasks, 0);
  }

  /**
   * Recursive decomposition of a non-atomic task into sub-tasks.
   */
  async subDecompose(
    parentTask: TaskSpec,
    context: string,
    model: string,
  ): Promise<TaskSpec[]> {
    // Switch to sub-decomposition prompt, then restore
    const savedPrompt = this.systemPrompt;
    this.systemPrompt = SUB_DECOMPOSE_PROMPT;

    const skillHint = this.getSkillHint(parentTask.description);

    const prompt = `Décompose cette tâche en sous-tâches :

Tâche : ${parentTask.name}
Description : ${parentTask.description}
Critères d'acceptation : ${parentTask.acceptanceCriteria.join(", ")}
${context ? `Contexte des tâches précédentes :\n${context}` : ""}${skillHint}`;

    try {
      const { parsed } = await this.callJSON<DecomposeResponse>(prompt, model);
      return this.buildTaskSpecs(
        parsed.tasks,
        parentTask.depth + 1,
        parentTask.id,
      );
    } finally {
      this.systemPrompt = savedPrompt;
    }
  }

  private buildTaskSpecs(
    rawTasks: DecomposeResponse["tasks"],
    depth: number,
    parentTaskId?: string,
  ): TaskSpec[] {
    // Create a name→id map to resolve internal dependencies
    const nameToId = new Map<string, string>();
    const tasks: TaskSpec[] = [];

    // First pass: assign IDs
    for (const raw of rawTasks) {
      const id = randomUUID().slice(0, 8);
      nameToId.set(raw.name, id);
    }

    // Second pass: build TaskSpecs with resolved dependencies
    for (const raw of rawTasks) {
      const id = nameToId.get(raw.name)!;
      const resolvedDeps = raw.dependsOn
        .map((dep) => nameToId.get(dep))
        .filter((d): d is string => d !== undefined);

      tasks.push({
        id,
        name: raw.name,
        description: raw.description,
        complexity: raw.complexity,
        isAtomic: raw.isAtomic,
        dependsOn: resolvedDeps,
        acceptanceCriteria: raw.acceptanceCriteria,
        toolsNeeded: raw.toolsNeeded,
        maxRetries: 2,
        parentTaskId,
        depth,
        children: undefined,
      });
    }

    return tasks;
  }

  /** Build a prompt hint listing relevant skills from the library */
  private getSkillHint(description: string): string {
    if (!this.skillLibrary) return "";

    const relevant = this.skillLibrary.findRelevant(description, 5);
    if (relevant.length === 0) return "";

    const lines = relevant.map(
      (s) => `  - ${s.definition.name} (score: ${s.meta.score}/100): ${s.definition.description}`,
    );

    return `\n\nSkills disponibles (réutilise-les dans toolsNeeded si pertinent) :\n${lines.join("\n")}`;
  }
}

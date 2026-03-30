import YAML from "yaml";
import { join } from "path";
import { homedir } from "os";
import type { ProjectBrief, TaskResult, TaskSpec } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Memory {
  type: "pattern" | "preference" | "history";
  content: string;
  confidence: number; // 0-100
  source: string; // project name or id
  createdAt: string;
  lastUsed: string;
  useCount: number;
}

export interface ProjectHistorySummary {
  objective: string;
  outcome: "success" | "partial" | "failed";
  tasks: number;
  learnings: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_HISTORY_ENTRIES = 50;
const DEFAULT_BASE_PATH = join(homedir(), ".arcti", "memory");

// ─── ProjectMemory ──────────────────────────────────────────────────────────

export class ProjectMemory {
  private basePath: string;
  private patterns: Memory[] = [];
  private preferences: Map<string, Memory> = new Map();
  private history: Memory[] = [];

  constructor(basePath?: string) {
    this.basePath = basePath ?? DEFAULT_BASE_PATH;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // Ensure directory structure exists
    const dir = Bun.file(join(this.basePath, ".keep"));
    if (!(await dir.exists())) {
      await Bun.write(dir, "");
    }
    await this.load();
  }

  // ── Add memories ────────────────────────────────────────────────────────

  addPattern(content: string, source: string): void {
    // Check for duplicate patterns — boost confidence if already exists
    const existing = this.patterns.find(
      (p) => p.content.toLowerCase() === content.toLowerCase()
    );
    if (existing) {
      existing.confidence = Math.min(100, existing.confidence + 10);
      existing.lastUsed = new Date().toISOString();
      existing.useCount++;
      return;
    }

    this.patterns.push({
      type: "pattern",
      content,
      confidence: 50,
      source,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      useCount: 1,
    });
  }

  addPreference(key: string, value: string, source: string): void {
    const existing = this.preferences.get(key);
    if (existing) {
      // Update existing preference, boost confidence
      existing.content = `${key}: ${value}`;
      existing.confidence = Math.min(100, existing.confidence + 15);
      existing.lastUsed = new Date().toISOString();
      existing.useCount++;
      existing.source = source;
      return;
    }

    this.preferences.set(key, {
      type: "preference",
      content: `${key}: ${value}`,
      confidence: 60,
      source,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      useCount: 1,
    });
  }

  addProjectHistory(summary: ProjectHistorySummary): void {
    const entry: Memory = {
      type: "history",
      content: YAML.stringify({
        objective: summary.objective,
        outcome: summary.outcome,
        tasks: summary.tasks,
        learnings: summary.learnings,
      }),
      confidence: 100,
      source: summary.objective.slice(0, 60),
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      useCount: 1,
    };

    this.history.push(entry);

    // Keep only the last N entries
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history = this.history.slice(-MAX_HISTORY_ENTRIES);
    }
  }

  // ── Query memories ──────────────────────────────────────────────────────

  getRelevantContext(objective: string): string {
    const keywords = objective
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    const sections: string[] = [];

    // Relevant patterns (score by keyword match + confidence)
    const scoredPatterns = this.patterns
      .map((p) => {
        const text = p.content.toLowerCase();
        const matchCount = keywords.filter((k) => text.includes(k)).length;
        const score = matchCount * 20 + p.confidence + p.useCount * 5;
        return { memory: p, score };
      })
      .filter((s) => s.score > 30)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (scoredPatterns.length > 0) {
      sections.push(
        "## Known Patterns\n" +
          scoredPatterns
            .map(
              (s) =>
                `- [confidence: ${s.memory.confidence}%] ${s.memory.content}`
            )
            .join("\n")
      );
    }

    // All preferences
    const prefs = this.getPreferences();
    if (Object.keys(prefs).length > 0) {
      sections.push(
        "## User Preferences\n" +
          Object.entries(prefs)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join("\n")
      );
    }

    // Recent relevant history
    const relevantHistory = this.history
      .filter((h) => {
        const text = h.content.toLowerCase();
        return keywords.some((k) => text.includes(k));
      })
      .slice(-5);

    if (relevantHistory.length > 0) {
      sections.push(
        "## Relevant Past Projects\n" +
          relevantHistory
            .map((h) => {
              const data = YAML.parse(h.content) as ProjectHistorySummary;
              return `- **${data.objective}** (${data.outcome}): ${data.learnings.join("; ")}`;
            })
            .join("\n")
      );
    }

    return sections.length > 0
      ? sections.join("\n\n")
      : "No relevant memories found.";
  }

  getPreferences(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, memory] of this.preferences) {
      // Extract value from "key: value" content format
      const colonIdx = memory.content.indexOf(": ");
      result[key] =
        colonIdx >= 0 ? memory.content.slice(colonIdx + 2) : memory.content;
    }
    return result;
  }

  getPatterns(minConfidence: number = 0): Memory[] {
    return this.patterns
      .filter((p) => p.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  // ── Auto-extract learnings ──────────────────────────────────────────────

  extractLearnings(
    brief: ProjectBrief,
    results: TaskResult[],
    tasks: Map<string, TaskSpec>
  ): void {
    const source = brief.objective.slice(0, 60);
    const learnings: string[] = [];

    // Analyze task outcomes
    const completed = results.filter((r) => r.status === "completed");
    const failed = results.filter((r) => r.status === "failed");
    const verified = results.filter((r) => r.status === "verified");

    // Detect successful approaches from verified tasks only
    for (const result of verified) {
      const spec = tasks.get(result.taskId);
      if (!spec) continue;

      // Extract patterns from tools that worked
      if (spec.toolsNeeded.length > 0) {
        const toolStr = spec.toolsNeeded.join(", ");
        this.addPattern(
          `For "${spec.name}" type tasks, tools [${toolStr}] worked well`,
          source
        );
      }

      // Learn from verification feedback
      if (result.verification?.passed && result.verification.feedback) {
        learnings.push(result.verification.feedback);
      }
    }

    // Detect patterns from failures
    for (const result of failed) {
      const spec = tasks.get(result.taskId);
      if (!spec) continue;

      if (result.verification && !result.verification.passed) {
        const issues = result.verification.issues.join("; ");
        this.addPattern(
          `Avoid: "${spec.name}" failed due to: ${issues}`,
          source
        );
        learnings.push(`Task "${spec.name}" failed: ${issues}`);
      }
    }

    // Extract user preferences from brief constraints
    for (const constraint of brief.constraints) {
      const lower = constraint.toLowerCase();

      // Detect stack preferences
      if (lower.includes("react")) this.addPreference("frontend", "React", source);
      if (lower.includes("vue")) this.addPreference("frontend", "Vue", source);
      if (lower.includes("svelte")) this.addPreference("frontend", "Svelte", source);
      if (lower.includes("typescript")) this.addPreference("language", "TypeScript", source);
      if (lower.includes("python")) this.addPreference("language", "Python", source);
      if (lower.includes("tailwind")) this.addPreference("css", "Tailwind", source);
      if (lower.includes("bun")) this.addPreference("runtime", "Bun", source);
      if (lower.includes("node")) this.addPreference("runtime", "Node.js", source);

      // Detect style preferences
      if (lower.includes("minimal")) this.addPreference("style", "minimal", source);
      if (lower.includes("dark mode") || lower.includes("dark theme"))
        this.addPreference("theme", "dark", source);
    }

    // Determine overall outcome
    const totalTasks = results.length;
    const successRate =
      totalTasks > 0 ? (completed.length + verified.length) / totalTasks : 0;
    const outcome: ProjectHistorySummary["outcome"] =
      successRate >= 0.8 ? "success" : successRate >= 0.4 ? "partial" : "failed";

    // Save project history
    this.addProjectHistory({
      objective: brief.objective,
      outcome,
      tasks: totalTasks,
      learnings,
    });
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  async save(): Promise<void> {
    const patternsPath = join(this.basePath, "patterns.yaml");
    const prefsPath = join(this.basePath, "preferences.yaml");
    const historyPath = join(this.basePath, "history.yaml");

    await Promise.all([
      Bun.write(patternsPath, YAML.stringify(this.patterns)),
      Bun.write(
        prefsPath,
        YAML.stringify(Array.from(this.preferences.values()))
      ),
      Bun.write(historyPath, YAML.stringify(this.history)),
    ]);
  }

  async load(): Promise<void> {
    const patternsPath = join(this.basePath, "patterns.yaml");
    const prefsPath = join(this.basePath, "preferences.yaml");
    const historyPath = join(this.basePath, "history.yaml");

    // Load patterns
    const patternsFile = Bun.file(patternsPath);
    if (await patternsFile.exists()) {
      const raw = await patternsFile.text();
      const parsed = YAML.parse(raw);
      if (Array.isArray(parsed)) {
        this.patterns = parsed as Memory[];
      }
    }

    // Load preferences
    const prefsFile = Bun.file(prefsPath);
    if (await prefsFile.exists()) {
      const raw = await prefsFile.text();
      const parsed = YAML.parse(raw);
      if (Array.isArray(parsed)) {
        this.preferences = new Map();
        for (const mem of parsed as Memory[]) {
          const colonIdx = mem.content.indexOf(": ");
          const key = colonIdx >= 0 ? mem.content.slice(0, colonIdx) : mem.content;
          this.preferences.set(key, mem);
        }
      }
    }

    // Load history
    const historyFile = Bun.file(historyPath);
    if (await historyFile.exists()) {
      const raw = await historyFile.text();
      const parsed = YAML.parse(raw);
      if (Array.isArray(parsed)) {
        this.history = (parsed as Memory[]).slice(-MAX_HISTORY_ENTRIES);
      }
    }
  }
}

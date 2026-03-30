import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { ToolParameter } from "../core/types.ts";
import { logger } from "../observability/logger.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  code: string;
}

export interface SkillMeta {
  score: number;          // 0-100, moving average
  uses: number;           // total executions
  successes: number;      // verification passed
  failures: number;       // verification failed
  avgDurationMs: number;  // moving average
  avgTokens: number;      // moving average (prompt + completion)
  createdAt: string;      // ISO date
  updatedAt: string;      // ISO date
  deprecated: boolean;
}

export interface SkillRecord {
  definition: SkillDefinition;
  meta: SkillMeta;
}

export interface SkillIndex {
  skills: Array<{
    name: string;
    description: string;
    score: number;
    uses: number;
    deprecated: boolean;
  }>;
  updatedAt: string;
}

// ─── Library ─────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(process.env.HOME ?? "~", ".arcti", "skills");
const INDEX_FILE = join(SKILLS_DIR, "index.json");

export class SkillLibrary {
  private dir: string;
  private indexPath: string;
  private cache = new Map<string, SkillRecord>();
  private log = logger.child("skill-lib");

  constructor(dir?: string) {
    this.dir = dir ?? SKILLS_DIR;
    this.indexPath = dir ? join(dir, "index.json") : INDEX_FILE;
    this.ensureDir();
    this.loadAll();
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /** Get a skill by name */
  get(name: string): SkillRecord | undefined {
    return this.cache.get(name);
  }

  /** List all non-deprecated skills, sorted by score desc */
  list(includeDeprecated = false): SkillRecord[] {
    const all = Array.from(this.cache.values());
    const filtered = includeDeprecated ? all : all.filter((s) => !s.meta.deprecated);
    return filtered.sort((a, b) => b.meta.score - a.meta.score);
  }

  /** Search skills by keyword in name or description */
  search(query: string): SkillRecord[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (s) =>
        s.definition.name.toLowerCase().includes(q) ||
        s.definition.description.toLowerCase().includes(q),
    );
  }

  /** Get top N skills suitable for a task description */
  findRelevant(taskDescription: string, limit = 5): SkillRecord[] {
    const words = taskDescription.toLowerCase().split(/\s+/);
    const scored = this.list().map((skill) => {
      const text = `${skill.definition.name} ${skill.definition.description}`.toLowerCase();
      const matches = words.filter((w) => w.length > 3 && text.includes(w)).length;
      return { skill, relevance: matches * skill.meta.score };
    });
    return scored
      .filter((s) => s.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map((s) => s.skill);
  }

  // ─── Write ───────────────────────────────────────────────────────────────

  /** Save a new skill (from generator) */
  async save(definition: SkillDefinition): Promise<SkillRecord> {
    const existing = this.cache.get(definition.name);
    if (existing) {
      // Update definition but keep meta
      existing.definition = definition;
      existing.meta.updatedAt = new Date().toISOString();
      await this.persist(existing);
      this.log.info(`Updated skill: ${definition.name}`);
      return existing;
    }

    const now = new Date().toISOString();
    const record: SkillRecord = {
      definition,
      meta: {
        score: 50, // neutral starting score
        uses: 0,
        successes: 0,
        failures: 0,
        avgDurationMs: 0,
        avgTokens: 0,
        createdAt: now,
        updatedAt: now,
        deprecated: false,
      },
    };

    this.cache.set(definition.name, record);
    await this.persist(record);
    await this.rebuildIndex();
    this.log.info(`Saved new skill: ${definition.name} (score: 50)`);
    return record;
  }

  /** Record execution result and update score */
  async recordExecution(
    name: string,
    result: {
      passed: boolean;
      issues: string[];
      durationMs: number;
      promptTokens: number;
      completionTokens: number;
    },
  ): Promise<number | null> {
    const record = this.cache.get(name);
    if (!record) return null;

    const meta = record.meta;
    meta.uses++;

    if (result.passed) {
      meta.successes++;
    } else {
      meta.failures++;
    }

    // Moving average for duration and tokens
    const totalTokens = result.promptTokens + result.completionTokens;
    if (meta.uses === 1) {
      meta.avgDurationMs = result.durationMs;
      meta.avgTokens = totalTokens;
    } else {
      const alpha = 0.3; // weight for new observation
      meta.avgDurationMs = meta.avgDurationMs * (1 - alpha) + result.durationMs * alpha;
      meta.avgTokens = meta.avgTokens * (1 - alpha) + totalTokens * alpha;
    }

    // Compute new score
    meta.score = this.computeScore(meta, result);
    meta.updatedAt = new Date().toISOString();

    // Auto-deprecate poor skills after enough uses
    if (meta.uses >= 3 && meta.score < 30) {
      meta.deprecated = true;
      this.log.warn(`Deprecated skill: ${name} (score: ${meta.score})`);
    }

    await this.persist(record);
    await this.rebuildIndex();
    this.log.info(`Scored skill "${name}": ${meta.score}/100 (uses: ${meta.uses})`);
    return meta.score;
  }

  /** Remove a skill */
  async remove(name: string): Promise<boolean> {
    const record = this.cache.get(name);
    if (!record) return false;

    this.cache.delete(name);
    const filePath = join(this.dir, `${this.sanitizeName(name)}.yaml`);
    if (existsSync(filePath)) unlinkSync(filePath);
    await this.rebuildIndex();
    this.log.info(`Removed skill: ${name}`);
    return true;
  }

  // ─── Scoring ─────────────────────────────────────────────────────────────

  private computeScore(
    meta: SkillMeta,
    latest: { passed: boolean; issues: string[] },
  ): number {
    // Base: success rate (0-60 points)
    const successRate = meta.uses > 0 ? meta.successes / meta.uses : 0.5;
    const successScore = successRate * 60;

    // Reliability bonus: consecutive successes (0-20 points)
    // Approximated by recent success rate with higher weight
    const reliabilityScore = latest.passed ? 20 : Math.max(0, 20 - latest.issues.length * 5);

    // Efficiency: fewer tokens = better (0-20 points)
    // Normalized: <500 tokens = 20, >5000 tokens = 0
    const tokenScore = Math.max(0, Math.min(20, 20 - (meta.avgTokens - 500) / 225));

    const raw = successScore + reliabilityScore + tokenScore;

    // Moving average with previous score (smooth transitions)
    if (meta.uses <= 1) return Math.round(Math.max(0, Math.min(100, raw)));
    const smoothed = meta.score * 0.4 + raw * 0.6;
    return Math.round(Math.max(0, Math.min(100, smoothed)));
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private async persist(record: SkillRecord): Promise<void> {
    const fileName = `${this.sanitizeName(record.definition.name)}.yaml`;
    const filePath = join(this.dir, fileName);
    const content = yamlStringify(record);
    await Bun.write(filePath, content);
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return;

    const files = readdirSync(this.dir).filter((f) => f.endsWith(".yaml"));
    this.cache.clear();

    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), "utf-8");
        const record = yamlParse(raw) as SkillRecord;
        if (record?.definition?.name) {
          this.cache.set(record.definition.name, record);
        }
      } catch {
        this.log.warn(`Failed to load skill file: ${file}`);
      }
    }

    this.log.debug(`Loaded ${this.cache.size} skills from disk`);
  }

  private async rebuildIndex(): Promise<void> {
    const index: SkillIndex = {
      skills: Array.from(this.cache.values()).map((r) => ({
        name: r.definition.name,
        description: r.definition.description,
        score: r.meta.score,
        uses: r.meta.uses,
        deprecated: r.meta.deprecated,
      })),
      updatedAt: new Date().toISOString(),
    };

    await Bun.write(this.indexPath, JSON.stringify(index, null, 2));
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  getStats(): {
    total: number;
    active: number;
    deprecated: number;
    avgScore: number;
  } {
    const all = Array.from(this.cache.values());
    const active = all.filter((s) => !s.meta.deprecated);
    const avgScore =
      active.length > 0
        ? Math.round(active.reduce((sum, s) => sum + s.meta.score, 0) / active.length)
        : 0;

    return {
      total: all.length,
      active: active.length,
      deprecated: all.length - active.length,
      avgScore,
    };
  }
}

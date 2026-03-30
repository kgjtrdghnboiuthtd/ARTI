import { z } from "zod/v4";

// ─── Task Complexity & Status ───────────────────────────────────────────────

export const Complexity = z.enum(["low", "medium", "high"]);
export type Complexity = z.infer<typeof Complexity>;

export const TaskStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "verified",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

// ─── Token Usage ────────────────────────────────────────────────────────────

export const TokenUsage = z.object({
  promptTokens: z.number().default(0),
  completionTokens: z.number().default(0),
  estimatedCostUsd: z.number().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

// ─── Verification ───────────────────────────────────────────────────────────

export const VerificationResult = z.object({
  passed: z.boolean(),
  issues: z.array(z.string()).default([]),
  shouldEscalate: z.boolean().default(false),
  feedback: z.string().default(""),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

// ─── Task Spec (what needs to be done) ──────────────────────────────────────

export const TaskSpec = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  complexity: Complexity,
  isAtomic: z.boolean(),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  toolsNeeded: z.array(z.string()).default([]),
  maxRetries: z.number().default(2),
  parentTaskId: z.string().optional(),
  depth: z.number().default(0),
  children: z.array(z.string()).optional(),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

// ─── Task Result (output of execution) ──────────────────────────────────────

export const TaskResult = z.object({
  taskId: z.string(),
  status: TaskStatus,
  output: z.string().default(""),
  modelUsed: z.string().default(""),
  attempts: z.number().default(0),
  tokenUsage: TokenUsage.default({}),
  durationMs: z.number().default(0),
  verification: VerificationResult.optional(),
});
export type TaskResult = z.infer<typeof TaskResult>;

// ─── Project Brief (output of QCM/intake) ───────────────────────────────────

export const ProjectBrief = z.object({
  objective: z.string(), // Quoi
  targetAudience: z.string().default(""), // Qui
  constraints: z.array(z.string()).default([]), // Comment
  timeline: z.string().optional(), // Quand
  motivation: z.string().optional(), // Pourquoi
  budgetScope: z.string().optional(), // Combien
  successCriteria: z.array(z.string()).default([]),
  rawUserInput: z.string(),
});
export type ProjectBrief = z.infer<typeof ProjectBrief>;

// ─── LLM Messages ──────────────────────────────────────────────────────────

export const LLMRole = z.enum(["system", "user", "assistant"]);
export type LLMRole = z.infer<typeof LLMRole>;

export const LLMMessage = z.object({
  role: LLMRole,
  content: z.string(),
});
export type LLMMessage = z.infer<typeof LLMMessage>;

export const LLMResponse = z.object({
  content: z.string(),
  model: z.string(),
  tokenUsage: TokenUsage.default({}),
  durationMs: z.number().default(0),
});
export type LLMResponse = z.infer<typeof LLMResponse>;

// ─── Tool Definition ────────────────────────────────────────────────────────

export const ToolParameter = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  required: z.boolean().default(true),
});
export type ToolParameter = z.infer<typeof ToolParameter>;

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.array(ToolParameter).default([]),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export interface ToolExecutor {
  definition: ToolDefinition;
  execute(params: Record<string, unknown>): Promise<string>;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export interface ArctiEvents {
  "task:created": TaskSpec;
  "task:started": { taskId: string; model: string };
  "task:completed": TaskResult;
  "task:failed": TaskResult;
  "task:verified": { taskId: string; result: VerificationResult };
  "task:decomposed": { parentId: string; children: TaskSpec[] };
  "task:stream-chunk": { taskId: string; chunk: string; model: string };
  "task:feedback-request": { taskId: string; output: string; question: string };
  "task:user-feedback": { taskId: string; feedback: string };
  "project:created": { name: string; provider: string; workDir: string | null; source: string };
  "project:intake-start": void;
  "project:intake-questions": { questions: string[] };
  "project:intake-done": ProjectBrief;
  "project:complete": { projectId: string; results: TaskResult[]; totalTokens: TokenUsage };
  "project:aborted": { reason: string };
  "llm:call": { model: string; promptTokens: number };
  "llm:response": LLMResponse;
}

// ─── Recursion Limits ───────────────────────────────────────────────────────

export const RecursionLimits = z.object({
  maxDepth: z.number().default(4),
  maxTotalTasks: z.number().default(50),
});
export type RecursionLimits = z.infer<typeof RecursionLimits>;

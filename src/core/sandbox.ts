import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SupportedLanguage = "typescript" | "javascript" | "python" | "shell";

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface SandboxOptions {
  /** Max execution time in milliseconds (default: 30_000) */
  timeoutMs?: number;
  /** Max combined output size in bytes (default: 102_400 = 100KB) */
  maxOutputBytes?: number;
  /** Block network access via environment hint (default: false) */
  noNetwork?: boolean;
  /** Working directory override (default: auto-created temp dir) */
  workDir?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 102_400;

const LANG_FILE_EXT: Record<SupportedLanguage, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  shell: "sh",
};

const LANG_COMMAND: Record<SupportedLanguage, (file: string) => string[]> = {
  typescript: (f) => ["bun", "run", f],
  javascript: (f) => ["bun", "run", f],
  python: (f) => ["python3", f],
  shell: (f) => ["bash", f],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Detect language from a fenced code block info string */
function detectLanguage(infoString: string): SupportedLanguage | null {
  const tag = infoString.trim().toLowerCase();
  if (tag === "ts" || tag === "typescript" || tag === "tsx") return "typescript";
  if (tag === "js" || tag === "javascript" || tag === "jsx") return "javascript";
  if (tag === "py" || tag === "python" || tag === "python3") return "python";
  if (tag === "sh" || tag === "bash" || tag === "shell" || tag === "zsh") return "shell";
  return null;
}

/** Truncate a string to maxBytes (UTF-8 safe) */
function truncate(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  return new TextDecoder().decode(encoded.slice(0, maxBytes)) + "\n... [truncated]";
}

// ─── CodeSandbox ────────────────────────────────────────────────────────────

export class CodeSandbox {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly noNetwork: boolean;
  private readonly workDir: string | undefined;

  constructor(options: SandboxOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.noNetwork = options.noNetwork ?? false;
    this.workDir = options.workDir;
  }

  /**
   * Execute a code snippet in an isolated temp directory.
   */
  async execute(
    code: string,
    language: SupportedLanguage,
    overrides: Partial<SandboxOptions> = {},
  ): Promise<ExecutionResult> {
    const timeout = overrides.timeoutMs ?? this.timeoutMs;
    const maxOutput = overrides.maxOutputBytes ?? this.maxOutputBytes;
    const noNet = overrides.noNetwork ?? this.noNetwork;

    // Create an isolated temp directory
    const tempBase = overrides.workDir ?? this.workDir ?? tmpdir();
    const dir = await mkdtemp(join(tempBase, "arcti-sandbox-"));

    const ext = LANG_FILE_EXT[language];
    const filePath = join(dir, `main.${ext}`);

    try {
      // Write code to file using Bun.write
      await Bun.write(filePath, code);

      const cmd = LANG_COMMAND[language](filePath);

      // Build environment: optionally block network
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        HOME: dir,
        TMPDIR: dir,
      };

      if (noNet) {
        // Hint to disable network (works for some runtimes / scripts)
        env.NO_NETWORK = "1";
        env.http_proxy = "http://0.0.0.0:0";
        env.https_proxy = "http://0.0.0.0:0";
        env.HTTP_PROXY = "http://0.0.0.0:0";
        env.HTTPS_PROXY = "http://0.0.0.0:0";
      }

      const start = performance.now();

      const proc = Bun.spawn(cmd, {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      // Set up timeout
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
      }, timeout);

      // Read output streams
      const [stdoutRaw, stderrRaw] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const durationMs = Math.round(performance.now() - start);

      return {
        success: exitCode === 0,
        stdout: truncate(stdoutRaw, maxOutput),
        stderr: truncate(stderrRaw, maxOutput),
        exitCode,
        durationMs,
      };
    } finally {
      // Cleanup temp directory
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ─── Code Block Extraction ──────────────────────────────────────────────────

interface ExtractedBlock {
  language: SupportedLanguage;
  code: string;
}

/**
 * Extract fenced code blocks from LLM output text.
 * Matches ```lang\n...\n``` patterns.
 */
export function extractCodeBlocks(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  const regex = /```(\w+)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const lang = detectLanguage(match[1]!);
    if (lang) {
      blocks.push({ language: lang, code: match[2]!.trim() });
    }
  }

  return blocks;
}

/**
 * Returns true if the text contains at least one runnable code block.
 */
export function containsRunnableCode(text: string): boolean {
  return extractCodeBlocks(text).length > 0;
}

// ─── High-Level Helper ──────────────────────────────────────────────────────

export interface CodeBlockResult extends ExecutionResult {
  language: SupportedLanguage;
  code: string;
}

/**
 * Extract all code blocks from LLM output, execute each in a sandbox,
 * and return results. Blocks are run sequentially.
 */
export async function extractAndRunCode(
  output: string,
  workDir?: string,
  options: SandboxOptions = {},
): Promise<CodeBlockResult[]> {
  const blocks = extractCodeBlocks(output);
  if (blocks.length === 0) return [];

  const sandbox = new CodeSandbox({ ...options, workDir });
  const results: CodeBlockResult[] = [];

  for (const block of blocks) {
    const result = await sandbox.execute(block.code, block.language);
    results.push({
      ...result,
      language: block.language,
      code: block.code,
    });
  }

  return results;
}

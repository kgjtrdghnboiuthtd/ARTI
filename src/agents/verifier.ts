import type { TaskSpec, TaskResult, VerificationResult } from "../core/types.ts";
import { BaseAgent, type AgentContext } from "./base.ts";
import type { TaskVerifier } from "../orchestrator/scheduler.ts";
import {
  CodeSandbox,
  containsRunnableCode,
  extractAndRunCode,
  type SandboxOptions,
  type CodeBlockResult,
} from "../core/sandbox.ts";

const VERIFIER_SYSTEM_PROMPT = `Vérifie si un résultat respecte ses critères. JSON uniquement :
{"passed":bool,"issues":[],"shouldEscalate":bool,"feedback":""}

passed=true si TOUS les critères OK. shouldEscalate=true si le problème nécessite un modèle supérieur.`;

export class VerifierAgent extends BaseAgent implements TaskVerifier {
  private sandbox: CodeSandbox | null;

  constructor(ctx: AgentContext, sandbox?: CodeSandbox | SandboxOptions) {
    super("verifier", VERIFIER_SYSTEM_PROMPT, ctx);

    if (sandbox instanceof CodeSandbox) {
      this.sandbox = sandbox;
    } else if (sandbox) {
      this.sandbox = new CodeSandbox(sandbox);
    } else {
      this.sandbox = null;
    }
  }

  async verify(
    task: TaskSpec,
    result: TaskResult,
  ): Promise<VerificationResult> {
    // If no acceptance criteria, auto-pass with basic sanity check
    if (task.acceptanceCriteria.length === 0) {
      if (result.output.trim().length === 0) {
        return {
          passed: false,
          issues: ["Le résultat est vide"],
          shouldEscalate: true,
          feedback: "L'agent n'a produit aucun output. Escalade nécessaire.",
        };
      }
      return {
        passed: true,
        issues: [],
        shouldEscalate: false,
        feedback: "",
      };
    }

    // ── Hallucination pre-check ──────────────────────────────────────────
    // If the task has no tools assigned but the output contains tool calls,
    // the model hallucinated tool usage instead of producing content
    if (task.toolsNeeded.length === 0) {
      const hallucinated = /```tool_call|{"tool"\s*:|fetch_url|read_file|write_file|shell_exec/.test(result.output);
      if (hallucinated) {
        return {
          passed: false,
          issues: [
            "L'agent a généré des appels d'outils fictifs au lieu de produire du contenu.",
            "La tâche n'a aucun outil assigné — le résultat doit être du contenu pur.",
          ],
          shouldEscalate: false,
          feedback: "Ne génère AUCUN appel d'outil. Produis directement le contenu demandé sans tool_call, fetch_url, ou autre simulation d'outil.",
        };
      }
    }

    // ── Sandbox execution for code-producing tasks ─────────────────────────
    let sandboxSection = "";

    if (this.sandbox && containsRunnableCode(result.output)) {
      const codeResults = await this.runCodeBlocks(result.output);

      if (codeResults.length > 0) {
        const anyFailed = codeResults.some((r) => !r.success);

        // If any code block crashed, fail immediately with details
        if (anyFailed) {
          const issues = codeResults
            .filter((r) => !r.success)
            .map((r) => {
              const snippet =
                r.code.length > 120 ? r.code.slice(0, 120) + "..." : r.code;
              const error = r.stderr.trim() || `Exit code ${r.exitCode}`;
              return `Code ${r.language} a échoué (${r.durationMs}ms): ${error}\n>>> ${snippet}`;
            });

          return {
            passed: false,
            issues,
            shouldEscalate: false,
            feedback:
              "L'exécution du code produit a échoué. Le code contient des erreurs.",
          };
        }

        // All blocks succeeded — include summary for the LLM verifier
        sandboxSection = "\n\n## Résultats d'exécution du code\n";
        for (const r of codeResults) {
          sandboxSection += `\n### ${r.language} (${r.durationMs}ms, exit ${r.exitCode})\n`;
          if (r.stdout.trim()) {
            sandboxSection += `stdout:\n${r.stdout.trim().slice(0, 2000)}\n`;
          }
          if (r.stderr.trim()) {
            sandboxSection += `stderr:\n${r.stderr.trim().slice(0, 1000)}\n`;
          }
        }
      }
    }

    // ── LLM-based verification (existing logic) ───────────────────────────
    const prompt = `## Tâche : ${task.name}
${task.description}

## Critères d'acceptation
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Résultat à vérifier
${result.output}${sandboxSection}

Vérifie si le résultat respecte TOUS les critères d'acceptation.`;

    // Use cheapest model for verification
    const { parsed } = await this.callJSON<VerificationResult>(
      prompt,
      result.modelUsed, // Will be overridden by router in scheduler
    );

    return {
      passed: parsed.passed ?? false,
      issues: parsed.issues ?? [],
      shouldEscalate: parsed.shouldEscalate ?? false,
      feedback: parsed.feedback ?? "",
    };
  }

  /**
   * Run extracted code blocks through the sandbox, catching any errors
   * so a sandbox failure doesn't break the entire verification flow.
   */
  private async runCodeBlocks(output: string): Promise<CodeBlockResult[]> {
    try {
      return await extractAndRunCode(output);
    } catch {
      // If sandbox itself errors (e.g. temp dir issue), fall back silently
      return [];
    }
  }
}

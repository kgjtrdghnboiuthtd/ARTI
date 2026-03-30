import type { ToolExecutor, ToolDefinition, ToolParameter } from "../core/types.ts";
import { ToolRegistry } from "./registry.ts";
import { BaseAgent, type AgentContext } from "../agents/base.ts";
import { logger } from "../observability/logger.ts";
import type { SkillLibrary } from "./skill-library.ts";

const GENERATOR_PROMPT = `Tu es un générateur d'outils. Tu crées des fonctions TypeScript pour accomplir des tâches spécifiques.

Quand on te demande de créer un outil, réponds en JSON :
{
  "name": "tool_name",
  "description": "What the tool does",
  "parameters": [
    { "name": "param1", "type": "string", "description": "...", "required": true }
  ],
  "code": "// TypeScript code that uses 'params' object and returns a string\\nconst result = params.param1;\\nreturn result;"
}

Le code sera exécuté dans un contexte où 'params' est un Record<string, unknown>.
Le code DOIT retourner une string.
N'utilise PAS d'imports, seulement du code JS/TS standard.`;

interface GeneratedTool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  code: string;
}

export class ToolGenerator extends BaseAgent {
  private registry: ToolRegistry;
  private skillLibrary: SkillLibrary | null;
  private log = logger.child("tool-gen");

  constructor(ctx: AgentContext, registry: ToolRegistry, skillLibrary?: SkillLibrary) {
    super("tool-generator", GENERATOR_PROMPT, ctx);
    this.registry = registry;
    this.skillLibrary = skillLibrary ?? null;
  }

  /**
   * Generate a new tool from a natural language description.
   */
  async generate(
    description: string,
    model: string,
  ): Promise<ToolExecutor> {
    this.log.info(`Generating tool: ${description}`);

    const { parsed } = await this.callJSON<GeneratedTool>(
      `Crée un outil pour : ${description}`,
      model,
    );

    const executor = this.buildExecutor(parsed);
    this.registry.register(executor);

    // Persist to skill library
    if (this.skillLibrary) {
      this.skillLibrary.save({
        name: parsed.name,
        description: parsed.description,
        parameters: parsed.parameters,
        code: parsed.code,
      });
    }

    this.log.info(`Generated and registered tool: ${parsed.name}`);
    return executor;
  }

  private buildExecutor(spec: GeneratedTool): ToolExecutor {
    const definition: ToolDefinition = {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    };

    return {
      definition,
      async execute(params: Record<string, unknown>): Promise<string> {
        // Block dangerous patterns in generated code
        const dangerousPatterns = [
          /process\.exit/i,
          /require\s*\(/,
          /import\s+/,
          /eval\s*\(/,
          /Function\s*\(/,
          /child_process/,
          /fs\.(unlink|rmdir|rm)/,
          /Bun\.(spawn|write|file)/,
        ];
        for (const pattern of dangerousPatterns) {
          if (pattern.test(spec.code)) {
            throw new Error(`Generated code contains dangerous pattern: ${pattern}`);
          }
        }

        // Create a sandboxed function from the generated code
        const fn = new Function("params", spec.code) as (
          params: Record<string, unknown>,
        ) => unknown;

        const result = fn(params);

        // Handle async results
        const resolved = result instanceof Promise ? await result : result;

        return typeof resolved === "string"
          ? resolved
          : JSON.stringify(resolved);
      },
    };
  }
}

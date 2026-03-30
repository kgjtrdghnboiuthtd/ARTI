import type { ToolExecutor, ToolDefinition } from "../core/types.ts";
import { logger } from "../observability/logger.ts";

export class ToolRegistry {
  private tools = new Map<string, ToolExecutor>();
  private log = logger.child("tools");

  register(tool: ToolExecutor): void {
    this.tools.set(tool.definition.name, tool);
    this.log.debug(`Registered tool: ${tool.definition.name}`);
  }

  get(name: string): ToolExecutor | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);

    this.log.info(`Executing tool: ${name}`);
    return tool.execute(params);
  }
}

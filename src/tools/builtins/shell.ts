import type { ToolExecutor } from "../../core/types.ts";

export const shellTool: ToolExecutor = {
  definition: {
    name: "shell",
    description: "Execute a shell command and return its output",
    parameters: [
      {
        name: "command",
        type: "string",
        description: "The shell command to execute",
        required: true,
      },
      {
        name: "timeout",
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
        required: false,
      },
    ],
  },
  async execute(params) {
    const command = params.command as string;
    const timeout = (params.timeout as number) ?? 30000;

    // Block dangerous commands (normalize to defeat whitespace/case evasion)
    const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
    const blocked = ["rm -rf /", "mkfs", "dd if=", "> /dev/"];
    for (const b of blocked) {
      if (normalized.includes(b)) {
        return `Error: Blocked dangerous command pattern: ${b}`;
      }
    }

    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), timeout);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      clearTimeout(timeoutId);

      let result = "";
      if (stdout) result += stdout;
      if (stderr) result += `\n[stderr]: ${stderr}`;
      result += `\n[exit: ${exitCode}]`;

      return result.trim();
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  },
};

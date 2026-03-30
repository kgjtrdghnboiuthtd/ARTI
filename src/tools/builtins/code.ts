import type { ToolExecutor } from "../../core/types.ts";

export const evalCodeTool: ToolExecutor = {
  definition: {
    name: "eval_code",
    description:
      "Execute TypeScript/JavaScript code in a sandboxed environment and return the result",
    parameters: [
      {
        name: "code",
        type: "string",
        description: "The TypeScript/JavaScript code to execute",
        required: true,
      },
      {
        name: "timeout",
        type: "number",
        description: "Timeout in milliseconds (default: 10000)",
        required: false,
      },
    ],
  },
  async execute(params) {
    const code = params.code as string;
    const timeout = (params.timeout as number) ?? 10000;

    // Block dangerous patterns
    const blocked = [
      "process.exit",
      "child_process",
      "require('fs')",
      "Bun.spawn",
      "import(",
    ];
    for (const b of blocked) {
      if (code.includes(b)) {
        return `Error: Blocked pattern in code: ${b}`;
      }
    }

    try {
      // Write to temp file and execute in subprocess for isolation
      const tmpFile = `/tmp/arcti-eval-${Date.now()}.ts`;
      await Bun.write(
        tmpFile,
        `
const __result = await (async () => {
  ${code}
})();
if (__result !== undefined) console.log(JSON.stringify(__result, null, 2));
`,
      );

      const proc = Bun.spawn(["bun", "run", tmpFile], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), timeout);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      clearTimeout(timeoutId);

      // Cleanup
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }

      if (stderr && !stdout) return `Error: ${stderr}`;
      return stdout.trim() || "(no output)";
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  },
};

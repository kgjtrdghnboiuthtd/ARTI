import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import type { ToolExecutor } from "../../core/types.ts";

export const readFileTool: ToolExecutor = {
  definition: {
    name: "read_file",
    description: "Read the contents of a file",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Path to the file to read",
        required: true,
      },
    ],
  },
  async execute(params) {
    const path = resolve(params.path as string);
    if (!existsSync(path)) return `Error: File not found: ${path}`;
    return readFileSync(path, "utf-8");
  },
};

export const writeFileTool: ToolExecutor = {
  definition: {
    name: "write_file",
    description: "Write content to a file",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Path to the file to write",
        required: true,
      },
      {
        name: "content",
        type: "string",
        description: "Content to write",
        required: true,
      },
    ],
  },
  async execute(params) {
    const path = resolve(params.path as string);
    writeFileSync(path, params.content as string, "utf-8");
    return `Written to ${path}`;
  },
};

export const listDirTool: ToolExecutor = {
  definition: {
    name: "list_dir",
    description: "List files and directories in a path",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Directory path to list",
        required: true,
      },
    ],
  },
  async execute(params) {
    const path = resolve(params.path as string);
    if (!existsSync(path)) return `Error: Directory not found: ${path}`;
    const entries = readdirSync(path, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
      .join("\n");
  },
};

import { join, dirname, resolve } from "path";
import { mkdirSync, existsSync } from "fs";
import { logger } from "../observability/logger.ts";

const log = logger.child("artifacts");

export interface ExtractedFile {
  filename: string;
  language: string;
  content: string;
}

/**
 * Extract file blocks from LLM output.
 *
 * Supports these patterns:
 *   ```lang#filename.ext      (explicit filename after #)
 *   ```lang // filename.ext   (filename in comment)
 *   // File: filename.ext     (header comment before block)
 *   /* filename.ext * /       (header comment before block)
 */
export function extractFiles(text: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  const seen = new Set<string>();

  // Pattern 1: ```lang#filename\n...```
  const hashPattern = /```(\w+)#([^\n]+)\n([\s\S]*?)```/g;
  for (const m of text.matchAll(hashPattern)) {
    const filename = m[2]!.trim();
    if (!seen.has(filename)) {
      files.push({ language: m[1]!, filename, content: m[3]!.trimEnd() });
      seen.add(filename);
    }
  }

  // Pattern 2: header "// File: X" or "/* X */" followed by ```
  const headerPattern = /(?:\/\/\s*(?:File|Fichier)\s*:\s*(.+)|\/\*\s*(.+?)\s*\*\/)\s*\n```(\w*)\n([\s\S]*?)```/g;
  for (const m of text.matchAll(headerPattern)) {
    const filename = (m[1] || m[2])!.trim();
    if (!seen.has(filename)) {
      files.push({ language: m[3] || "", filename, content: m[4]!.trimEnd() });
      seen.add(filename);
    }
  }

  // Pattern 3: ```lang // filename.ext\n...```
  const commentPattern = /```(\w+)\s+\/\/\s*([^\n]+)\n([\s\S]*?)```/g;
  for (const m of text.matchAll(commentPattern)) {
    const filename = m[2]!.trim();
    if (filename.includes(".") && !seen.has(filename)) {
      files.push({ language: m[1]!, filename, content: m[3]!.trimEnd() });
      seen.add(filename);
    }
  }

  return files;
}

/**
 * Try to infer a filename from code content and language.
 */
function inferFilename(language: string, _content: string, index: number): string {
  const extMap: Record<string, string> = {
    html: "index.html",
    css: "styles.css",
    scss: "styles.scss",
    js: "script.js",
    javascript: "script.js",
    ts: "index.ts",
    typescript: "index.ts",
    tsx: "App.tsx",
    jsx: "App.jsx",
    json: "data.json",
    yaml: "config.yaml",
    yml: "config.yml",
    py: "main.py",
    python: "main.py",
    sh: "run.sh",
    bash: "run.sh",
    sql: "schema.sql",
    md: "README.md",
    markdown: "README.md",
  };

  const base = extMap[language.toLowerCase()];
  if (base) {
    return index === 0 ? base : `${base.replace(".", `_${index}.`)}`;
  }
  return `output_${index}.txt`;
}

/**
 * Extract ALL code blocks (even without filenames) and assign filenames.
 * Used for the final synthesis output.
 */
export function extractAllCodeBlocks(text: string): ExtractedFile[] {
  // First try named files
  const named = extractFiles(text);
  if (named.length > 0) return named;

  // Fallback: extract all fenced blocks and assign filenames
  const files: ExtractedFile[] = [];
  const blockPattern = /```(\w*)\n([\s\S]*?)```/g;
  let i = 0;

  for (const m of text.matchAll(blockPattern)) {
    const lang = m[1] || "txt";
    const content = m[2]!.trimEnd();
    if (content.length < 10) continue; // skip tiny snippets

    files.push({
      language: lang,
      filename: inferFilename(lang, content, i),
      content,
    });
    i++;
  }

  return files;
}

/**
 * Write extracted files to a working directory.
 * Returns list of written file paths.
 */
export function writeArtifacts(workDir: string, files: ExtractedFile[]): string[] {
  const written: string[] = [];

  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
    log.info(`Created workDir: ${workDir}`);
  }

  for (const file of files) {
    const filePath = join(workDir, file.filename);
    const dir = dirname(filePath);

    // Security: don't write outside workDir (resolve to defeat ../ traversal)
    const normalizedWork = resolve(workDir);
    const normalizedFile = resolve(workDir, file.filename);
    if (!normalizedFile.startsWith(normalizedWork + "/") && normalizedFile !== normalizedWork) {
      log.warn("Path traversal blocked", { relativePath: file.filename, workDir });
      continue;
    }

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    Bun.write(filePath, file.content);
    written.push(filePath);
    log.info(`Wrote: ${file.filename} (${file.content.length} bytes)`);
  }

  return written;
}

/**
 * Write the final synthesis output to the working directory.
 * Extracts code blocks as files, and saves the full text as output.md.
 */
export function writeFinalOutput(workDir: string, synthesisOutput: string, taskOutputs: Map<string, { name: string; output: string }>): string[] {
  const allWritten: string[] = [];

  // Extract and write files from synthesis
  const synthFiles = extractAllCodeBlocks(synthesisOutput);
  if (synthFiles.length > 0) {
    allWritten.push(...writeArtifacts(workDir, synthFiles));
  }

  // Extract files from individual task outputs
  for (const [_id, task] of taskOutputs) {
    const taskFiles = extractFiles(task.output);
    if (taskFiles.length > 0) {
      allWritten.push(...writeArtifacts(workDir, taskFiles));
    }
  }

  // Always write the full synthesis as output.md
  const outputPath = join(workDir, "output.md");
  Bun.write(outputPath, synthesisOutput);
  allWritten.push(outputPath);
  log.info(`Wrote synthesis: output.md (${synthesisOutput.length} bytes)`);

  return allWritten;
}

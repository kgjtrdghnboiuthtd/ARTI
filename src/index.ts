#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";

import { loadConfig } from "./config.ts";
import { EventBus } from "./core/events.ts";
import { ProjectState } from "./core/state.ts";
import { LLMClient } from "./llm/client.ts";
import { ModelRouter } from "./llm/router.ts";
import { MotherAgent } from "./agents/mother.ts";
import { MetricsCollector } from "./observability/metrics.ts";
import { logger } from "./observability/logger.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { readFileTool, writeFileTool, listDirTool } from "./tools/builtins/filesystem.ts";
import { shellTool } from "./tools/builtins/shell.ts";
import { fetchUrlTool, webSearchTool } from "./tools/builtins/web.ts";
import { evalCodeTool } from "./tools/builtins/code.ts";
import { RunManager } from "./core/run-manager.ts";
import { ProjectMemory } from "./core/memory.ts";
import { SkillLibrary } from "./tools/skill-library.ts";
import { createApp, type ServerDeps } from "./server/app.ts";
import {
  attachWebSocket,
  handleWSConnection,
  handleWSClose,
} from "./server/websocket.ts";
import { BotManager } from "./bot/manager.ts";

// ─── Banner ─────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(
    chalk.cyan.bold(`
    ╔═══════════════════════════════╗
    ║         ARCTI v1.0.0          ║
    ║   Multi-Agent Orchestrator    ║
    ╚═══════════════════════════════╝
`),
  );
}

// ─── Interactive Q&A ────────────────────────────────────────────────────────

function askUser(questions: string[]): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log();
    const answers: string[] = [];
    let idx = 0;

    const askNext = () => {
      if (idx >= questions.length) {
        rl.close();
        resolve(answers.join("\n"));
        return;
      }

      rl.question(
        chalk.cyan(`  → ${questions[idx]}\n    > `),
        (answer) => {
          answers.push(`${questions[idx]}: ${answer}`);
          idx++;
          askNext();
        },
      );
    };

    askNext();
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

async function setup(configPath?: string) {
  const config = loadConfig(configPath);

  const events = new EventBus();
  const state = new ProjectState();
  state.events = events;

  const llm = new LLMClient(config);
  await llm.init(); // Detect Ollama models by mode, validate config
  const router = new ModelRouter(config);
  router.setOllamaModels(llm.getOllamaModels());
  const metrics = new MetricsCollector();
  metrics.attach(events);

  // Register built-in tools
  const tools = new ToolRegistry();
  tools.register(readFileTool);
  tools.register(writeFileTool);
  tools.register(listDirTool);
  tools.register(shellTool);
  tools.register(fetchUrlTool);
  tools.register(webSearchTool);
  tools.register(evalCodeTool);

  const skillLibrary = new SkillLibrary();

  const memory = new ProjectMemory();
  await memory.init();

  const mother = new MotherAgent(
    { llm, events },
    state,
    router,
    config,
    tools,
    undefined,
    skillLibrary,
    memory,
  );

  return { config, events, state, llm, router, metrics, tools, mother, skillLibrary, memory };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("arcti")
  .description("Multi-Agent Orchestrator — Coordinate AI agents efficiently")
  .version("1.0.0");

program
  .command("run")
  .description("Run a task through the multi-agent pipeline")
  .argument("<input...>", "The task to execute")
  .option("-c, --config <path>", "Path to config file")
  .action(async (inputParts: string[], opts: { config?: string }) => {
    printBanner();
    const input = inputParts.join(" ");
    const { mother, metrics, config } = await setup(opts.config);

    logger.info("Starting Arcti", {
      mode: config.providerMode,
      input: input.slice(0, 80),
    });

    try {
      const result = await mother.run(input, askUser);

      console.log(chalk.green.bold("\n═══ Résultat Final ═══\n"));
      console.log(result);

      metrics.printSummary();
    } catch (error) {
      logger.error("Pipeline failed", {
        error: (error as Error).message,
      });
      console.error(chalk.red(`\nErreur: ${(error as Error).message}`));
      process.exit(1);
    }
  });

program
  .command("server")
  .description("Start the web server with WebSocket support")
  .option("-c, --config <path>", "Path to config file")
  .option("-p, --port <number>", "Port number")
  .action(async (opts: { config?: string; port?: string }) => {
    printBanner();
    const ctx = await setup(opts.config);
    const port = opts.port ? parseInt(opts.port) : ctx.config.server.port;

    // Create RunManager with shared resources
    const runManager = new RunManager({
      config: ctx.config,
      llm: ctx.llm,
      router: ctx.router,
      tools: ctx.tools,
      globalEvents: ctx.events,
      skillLibrary: ctx.skillLibrary,
      memory: ctx.memory,
    });

    // ─── Bot Manager ────────────────────────────────────────────────
    const botManager = new BotManager(runManager, ctx.events);

    // Lire la config bots depuis le YAML (section "bots")
    // Note: camelCaseKeys convertit phone_id -> phoneId, verify_token -> verifyToken
    const rawConfig = ctx.config as unknown as Record<string, unknown>;
    const rawBots = (rawConfig.bots ?? {}) as Record<string, unknown>;
    const tgConf = rawBots.telegram as Record<string, unknown> | undefined;
    const waConf = rawBots.whatsapp as Record<string, unknown> | undefined;
    const botsConfig = {
      telegram: tgConf ? {
        enabled: !!tgConf.enabled,
        token: (tgConf.token as string) || "",
      } : undefined,
      whatsapp: waConf ? {
        enabled: !!waConf.enabled,
        token: (waConf.token as string) || "",
        phone_id: ((waConf.phoneId ?? waConf.phone_id) as string) || "",
        verify_token: ((waConf.verifyToken ?? waConf.verify_token) as string) || "",
      } : undefined,
    };

    const serverDeps: ServerDeps = {
      runManager,
      botManager,
    };

    const app = createApp(serverDeps);

    // Attach WebSocket event broadcasting to global events
    attachWebSocket(ctx.events);

    // Start Bun server with WebSocket support
    const server = Bun.serve({
      port,
      hostname: ctx.config.server.host,
      fetch(req, server) {
        // Handle WebSocket upgrade
        if (req.headers.get("upgrade") === "websocket") {
          const success = server.upgrade(req);
          if (success) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // Serve dashboard HTML for root
        const url = new URL(req.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(Bun.file(`${process.cwd()}/web/index.html`));
        }

        // Handle other HTTP via Hono
        return app.fetch(req);
      },
      websocket: {
        open(ws) {
          handleWSConnection(ws as unknown as Parameters<typeof handleWSConnection>[0]);
        },
        close(ws) {
          handleWSClose(ws as unknown as Parameters<typeof handleWSClose>[0]);
        },
        message() {
          // Clients don't send messages, they only receive events
        },
      },
    });

    logger.info("Server started", {
      url: `http://${ctx.config.server.host}:${port}`,
      ws: `ws://${ctx.config.server.host}:${port}`,
    });

    console.log(
      chalk.green(
        `\nServer running at ${chalk.bold(`http://${ctx.config.server.host}:${port}`)}`,
      ),
    );
    console.log(
      chalk.dim(
        `WebSocket at ws://${ctx.config.server.host}:${port}`,
      ),
    );
    console.log(chalk.dim("\nEndpoints:"));
    console.log(chalk.dim("  GET  /status  — Project status"));
    console.log(chalk.dim("  GET  /tasks   — All tasks and results"));
    console.log(chalk.dim("  GET  /metrics — Token usage metrics"));
    console.log(chalk.dim("  POST /run     — Start a new run"));
    console.log(chalk.dim("\nPress Ctrl+C to stop\n"));

    // ─── Start Bots ───────────────────────────────────────────────────
    await botManager.start(botsConfig);
    if (botsConfig.telegram?.enabled || botsConfig.whatsapp?.enabled) {
      console.log(chalk.dim("Bots:"));
      if (botsConfig.telegram?.enabled) console.log(chalk.dim("  Telegram bot enabled"));
      if (botsConfig.whatsapp?.enabled) {
        console.log(chalk.dim("  WhatsApp bot enabled"));
        console.log(chalk.dim("  GET  /webhook/whatsapp  — WhatsApp verification"));
        console.log(chalk.dim("  POST /webhook/whatsapp  — WhatsApp incoming"));
      }
      console.log();
    }
  });

program
  .command("check")
  .description("Check provider connectivity")
  .option("-c, --config <path>", "Path to config file")
  .action(async (opts: { config?: string }) => {
    printBanner();
    const { config, llm } = await setup(opts.config);

    console.log(chalk.dim(`Default provider: ${config.defaultProvider}\n`));

    const available = llm.listAvailableProviders();
    console.log(chalk.dim(`Enabled providers: ${available.join(", ")}\n`));

    // Check Ollama
    const ollama = llm.getOllamaProvider();
    if (ollama) {
      const ok = await ollama.isAvailable();
      console.log(
        ok ? chalk.green("✓ Ollama is reachable") : chalk.red("✗ Ollama is not reachable"),
      );
      if (ok) {
        const models = await ollama.listModels();
        console.log(chalk.dim(`  Models: ${models.join(", ") || "none"}`));
      }
    }

    // Check Claude Code CLI
    const cc = llm.getClaudeCodeProvider();
    if (cc) {
      const ok = await cc.isAvailable();
      console.log(
        ok ? chalk.green("✓ Claude Code CLI is available") : chalk.red("✗ Claude Code CLI not found"),
      );
    }

    // Check API keys
    for (const [name, conf] of Object.entries(config.providers)) {
      if (conf.apiKeyEnv && conf.enabled) {
        const key = process.env[conf.apiKeyEnv];
        console.log(
          key
            ? chalk.green(`✓ ${conf.apiKeyEnv} is set (${name})`)
            : chalk.red(`✗ ${conf.apiKeyEnv} is not set (${name})`),
        );
      }
    }
  });

program.parse();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { join, resolve } from "path";
import type { RunManager } from "../core/run-manager.ts";
import type { ProviderName } from "../config.ts";
import { PROVIDER_MODELS, PROVIDER_DEFAULT_TIERS, applySettingsUpdate } from "../config.ts";
import { estimateCost } from "../core/cost-estimator.ts";
import { logger } from "../observability/logger.ts";
import type { BotManager } from "../bot/manager.ts";

export interface ServerDeps {
  runManager: RunManager;
  botManager?: BotManager;
}

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const log = logger.child("server");
  const rm = deps.runManager;

  app.use("*", cors());

  // ─── Projects API ──────────────────────────────────────────────────

  app.get("/projects", (c) => {
    const runs = rm.listRuns().map((r) => ({
      id: r.id,
      name: r.name,
      input: r.input,
      status: r.status,
      provider: r.provider,
      workDir: r.workDir,
      artifacts: r.artifacts,
      createdAt: r.createdAt,
      taskCount: r.state.tasks.size,
      verified: [...r.state.results.values()].filter((x) => x.status === "verified").length,
    }));
    return c.json(runs);
  });

  app.post("/run", async (c) => {
    const body = await c.req.json<{ input: string; provider?: ProviderName; workDir?: string }>();
    if (!body.input) return c.json({ error: "input required" }, 400);

    log.info("Run request", { input: body.input, provider: body.provider, workDir: body.workDir });

    const run = rm.createRun(body.input, { provider: body.provider, workDir: body.workDir || undefined });
    rm.startRun(run);

    return c.json({ status: "started", projectId: run.id, provider: run.provider, workDir: run.workDir });
  });

  app.post("/projects/:id/stop", (c) => {
    const ok = rm.stopRun(c.req.param("id"));
    if (!ok) return c.json({ error: "No active run found" }, 400);
    return c.json({ status: "aborted" });
  });

  app.post("/projects/:id/answer", async (c) => {
    const body = await c.req.json<{ answer: string }>();
    if (!body.answer) return c.json({ error: "answer required" }, 400);

    const ok = rm.answerQuestions(c.req.param("id"), body.answer);
    if (!ok) return c.json({ error: "No pending questions for this project" }, 400);
    return c.json({ status: "answered" });
  });

  app.post("/projects/:id/tasks/:taskId/feedback", async (c) => {
    const body = await c.req.json<{ feedback: string; action: "approve" | "reject" | "redo" }>();
    if (!body.feedback && body.action !== "approve") return c.json({ error: "feedback required" }, 400);
    if (!body.action) return c.json({ error: "action required (approve | reject | redo)" }, 400);

    const projectId = c.req.param("id");
    const taskId = c.req.param("taskId");
    const run = rm.getRun(projectId);
    if (!run) return c.json({ error: "Project not found" }, 404);

    const task = run.state.tasks.get(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);

    if (body.action === "redo") {
      const ok = rm.requestTaskRedo(projectId, taskId, body.feedback);
      if (!ok) return c.json({ error: "Task cannot be redone (not verified or not found)" }, 400);
      return c.json({ status: "redo-scheduled", taskId });
    }

    // approve or reject → submit as feedback to a pending feedback request
    const ok = rm.submitTaskFeedback(projectId, taskId, body.action === "approve"
      ? body.feedback || "Approuvé par l'utilisateur."
      : body.feedback);
    if (!ok) return c.json({ error: "No pending feedback request for this task" }, 400);

    return c.json({ status: body.action === "approve" ? "approved" : "rejected", taskId });
  });

  app.delete("/projects/:id", (c) => {
    const ok = rm.deleteRun(c.req.param("id"));
    if (!ok) return c.json({ error: "Project not found" }, 404);
    return c.json({ status: "deleted" });
  });

  app.get("/projects/:id/status", (c) => {
    const run = rm.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Project not found" }, 404);

    const results = [...run.state.results.values()];
    return c.json({
      id: run.id,
      name: run.name,
      status: run.status,
      provider: run.provider,
      workDir: run.workDir,
      artifacts: run.artifacts,
      brief: run.state.brief,
      tasks: run.state.tasks.size,
      completed: results.filter((r) => r.status === "verified").length,
      failed: results.filter((r) => r.status === "failed").length,
      running: results.filter((r) => r.status === "running").length,
      pending: results.filter((r) => r.status === "pending").length,
      tokens: run.state.getTotalTokenUsage(),
    });
  });

  app.get("/projects/:id/tasks", (c) => {
    const run = rm.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Project not found" }, 404);

    const tasks = [...run.state.tasks.values()].map((task) => ({
      ...task,
      result: run.state.results.get(task.id) ?? null,
    }));
    return c.json(tasks);
  });

  app.get("/projects/:id/tasks/:taskId", (c) => {
    const run = rm.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Project not found" }, 404);

    const taskId = c.req.param("taskId");
    const task = run.state.tasks.get(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);

    return c.json({ ...task, result: run.state.results.get(taskId) ?? null });
  });

  app.get("/projects/:id/metrics", (c) => {
    const run = rm.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Project not found" }, 404);
    return c.json(run.metrics.getTotals());
  });

  app.get("/projects/:id/estimate", (c) => {
    const run = rm.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Project not found" }, 404);

    const tasks = [...run.state.tasks.values()];
    if (tasks.length === 0) {
      return c.json({ error: "No tasks found for this project" }, 400);
    }

    const config = rm.getConfig();
    const estimate = estimateCost(tasks, config);
    return c.json(estimate);
  });

  app.get("/projects/:id/export", (c) => {
    const run = rm.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "Project not found" }, 404);

    const tasks = [...run.state.tasks.values()];
    const results = [...run.state.results.values()];

    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      project: {
        name: run.name,
        input: run.input,
        provider: run.provider,
        workDir: run.workDir,
        status: run.status,
        brief: run.state.brief,
        tasks,
        results,
        metrics: run.metrics.getTotals(),
      },
    };

    return c.json(exportData);
  });

  app.post("/projects/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const data = body as {
      version?: string;
      project?: {
        name?: string;
        input?: string;
        provider?: string;
        workDir?: string | null;
        status?: string;
        brief?: unknown;
        tasks?: unknown[];
        results?: unknown[];
      };
    };

    if (!data.version || !data.project) {
      return c.json({ error: "Invalid export format: missing version or project" }, 400);
    }

    const p = data.project;
    if (!p.name || !p.input || !p.tasks || !p.results) {
      return c.json({ error: "Invalid export format: missing required project fields (name, input, tasks, results)" }, 400);
    }

    try {
      const run = rm.importRun({
        name: p.name,
        input: p.input,
        provider: (p.provider ?? "ollama") as ProviderName,
        workDir: p.workDir ?? null,
        status: p.status ?? "completed",
        brief: (p.brief as any) ?? null,
        tasks: p.tasks as any[],
        results: p.results as any[],
      });

      log.info("Project imported", { id: run.id, name: run.name });
      return c.json({ status: "imported", projectId: run.id, name: run.name });
    } catch (err) {
      log.error("Import failed", { error: (err as Error).message });
      return c.json({ error: `Import failed: ${(err as Error).message}` }, 500);
    }
  });

  // ─── Settings API ──────────────────────────────────────────────────

  app.get("/settings", (c) => {
    const config = rm.getConfig();
    return c.json({
      defaultProvider: config.defaultProvider,
      defaultModels: config.defaultModels,
      providers: config.providers,
    });
  });

  app.post("/settings", async (c) => {
    const body = await c.req.json<{
      defaultProvider?: ProviderName;
      defaultModels?: { tier1?: string; tier2?: string; tier3?: string };
      ollamaMode?: "local" | "cloud" | "both";
    }>();

    const config = rm.getConfig();
    const updated = applySettingsUpdate(config, body);
    rm.setConfig(updated);

    // Re-init LLM client when Ollama mode changes to refresh available models
    if (body.ollamaMode) {
      const llm = rm.getLLMClient();
      await llm.init();
      const router = rm.getRouter();
      if (router) router.setOllamaModels(llm.getOllamaModels());
      log.info("Ollama mode changed", { mode: body.ollamaMode });
    }

    log.info("Settings updated", { defaultProvider: updated.defaultProvider });
    return c.json({ status: "ok", defaultProvider: updated.defaultProvider, defaultModels: updated.defaultModels });
  });

  // ─── Provider Settings API ────────────────────────────────────────

  app.post("/settings/provider", async (c) => {
    const { provider, enabled, apiKey } = await c.req.json<{
      provider: string;
      enabled?: boolean;
      apiKey?: string;
    }>();

    const config = rm.getConfig();
    const pName = provider as ProviderName;

    if (!config.providers[pName]) {
      return c.json({ error: "Unknown provider" }, 400);
    }

    // Save API key to .env file if provided
    if (apiKey) {
      const envVar = config.providers[pName].apiKeyEnv;
      if (envVar) {
        // Set in current process
        process.env[envVar] = apiKey;

        // Persist to .env file
        const envPath = join(process.cwd(), ".env");
        const envFile = Bun.file(envPath);
        let envContent = (await envFile.exists()) ? await envFile.text() : "";

        // Replace existing or append
        const regex = new RegExp(`^${envVar}=.*$`, "m");
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${envVar}=${apiKey}`);
        } else {
          envContent += `\n${envVar}=${apiKey}`;
        }
        await Bun.write(envPath, envContent.trim() + "\n");
        log.info("API key saved", { provider: pName, envVar });
      }
    }

    // Toggle enabled state
    if (enabled !== undefined) {
      config.providers[pName].enabled = enabled;
    }

    rm.setConfig(config);

    // Re-init LLM client to pick up new provider/key
    const llm = rm.getLLMClient();
    llm.reinit(config);  // rebuild provider registry from updated config
    await llm.init();    // re-detect Ollama models
    const router = rm.getRouter();
    if (router) router.setOllamaModels(llm.getOllamaModels());

    log.info("Provider updated", { provider: pName, enabled: config.providers[pName].enabled });
    return c.json({ status: "ok" });
  });

  // ─── Bots Settings API ──────────────────────────────────────────────

  app.get("/settings/bots", async (c) => {
    try {
      const configPath = join(process.cwd(), "arcti.yaml");
      const file = Bun.file(configPath);
      if (await file.exists()) {
        const { parse } = await import("yaml");
        const raw = parse(await file.text());
        return c.json(raw?.bots ?? { telegram: { enabled: false, token: "" }, whatsapp: { enabled: false, token: "", phone_id: "", verify_token: "" } });
      }
    } catch {}
    return c.json({ telegram: { enabled: false, token: "" }, whatsapp: { enabled: false, token: "", phone_id: "", verify_token: "" } });
  });

  app.post("/settings/bots", async (c) => {
    const body = await c.req.json<{
      telegram?: { enabled: boolean; token: string };
      whatsapp?: { enabled: boolean; token: string; phone_id: string; verify_token: string };
    }>();

    try {
      // Read and update arcti.yaml
      const configPath = join(process.cwd(), "arcti.yaml");
      const { parse, stringify } = await import("yaml");
      const file = Bun.file(configPath);
      const raw = file.size > 0 ? parse(await file.text()) : {};

      raw.bots = {
        telegram: {
          enabled: body.telegram?.enabled ?? false,
          token: body.telegram?.token ?? "",
        },
        whatsapp: {
          enabled: body.whatsapp?.enabled ?? false,
          token: body.whatsapp?.token ?? "",
          phone_id: body.whatsapp?.phone_id ?? "",
          verify_token: body.whatsapp?.verify_token ?? "",
        },
      };

      await Bun.write(configPath, stringify(raw));
      log.info("Bot config saved to arcti.yaml");

      // Restart bots dynamically
      const active: string[] = [];
      if (deps.botManager) {
        deps.botManager.stop();
        await deps.botManager.start(raw.bots);
        if (raw.bots.telegram?.enabled && raw.bots.telegram?.token) active.push("Telegram");
        if (raw.bots.whatsapp?.enabled && raw.bots.whatsapp?.token) active.push("WhatsApp");
      }

      return c.json({ status: "ok", active });
    } catch (err) {
      log.error("Failed to save bot config", { error: (err as Error).message });
      return c.json({ error: "Failed to save bot config" }, 500);
    }
  });

  // ─── Providers API ─────────────────────────────────────────────────

  app.get("/providers", async (c) => {
    const config = rm.getConfig();
    const llm = rm.getLLMClient();
    const available = llm.listAvailableProviders();

    // Use detected models for Ollama (filtered by mode) instead of hardcoded list
    const ollamaModels = llm.getOllamaModels();

    const providers = Object.entries(config.providers).map(([name, conf]) => {
      const pName = name as ProviderName;
      const models = pName === "ollama" && ollamaModels.length > 0
        ? ollamaModels
        : (PROVIDER_MODELS[pName] ?? []);
      return {
        name: pName,
        enabled: conf.enabled,
        available: available.includes(pName),
        models,
        defaultTiers: PROVIDER_DEFAULT_TIERS[pName] ?? {},
        needsApiKey: !!conf.apiKeyEnv,
        hasApiKey: conf.apiKeyEnv ? !!process.env[conf.apiKeyEnv] : true,
      };
    });

    return c.json(providers);
  });

  app.get("/providers/:name/models", async (c) => {
    const name = c.req.param("name");
    const llm = rm.getLLMClient();
    try {
      const models = await llm.fetchProviderModels(name);
      return c.json(models);
    } catch {
      return c.json([]);
    }
  });

  // ─── Skills API ──────────────────────────────────────────────────

  app.get("/skills", (c) => {
    const lib = rm.getSkillLibrary();
    if (!lib) return c.json([]);

    const includeDeprecated = c.req.query("all") === "true";
    const skills = lib.list(includeDeprecated).map((s) => ({
      name: s.definition.name,
      description: s.definition.description,
      parameters: s.definition.parameters,
      score: s.meta.score,
      uses: s.meta.uses,
      successes: s.meta.successes,
      failures: s.meta.failures,
      avgDurationMs: Math.round(s.meta.avgDurationMs),
      deprecated: s.meta.deprecated,
      createdAt: s.meta.createdAt,
      updatedAt: s.meta.updatedAt,
    }));
    return c.json(skills);
  });

  app.get("/skills/stats", (c) => {
    const lib = rm.getSkillLibrary();
    if (!lib) return c.json({ total: 0, active: 0, deprecated: 0, avgScore: 0 });
    return c.json(lib.getStats());
  });

  app.get("/skills/:name", (c) => {
    const lib = rm.getSkillLibrary();
    if (!lib) return c.json({ error: "Skill library not available" }, 500);

    const skill = lib.get(c.req.param("name"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    return c.json(skill);
  });

  app.delete("/skills/:name", (c) => {
    const lib = rm.getSkillLibrary();
    if (!lib) return c.json({ error: "Skill library not available" }, 500);

    const ok = lib.remove(c.req.param("name"));
    if (!ok) return c.json({ error: "Skill not found" }, 404);
    return c.json({ status: "deleted" });
  });

  // ─── Open Folder ─────────────────────────────────────────────────

  app.post("/api/open-folder", async (c) => {
    const { path: folderPath } = await c.req.json<{ path: string }>();
    if (!folderPath || typeof folderPath !== "string") {
      return c.json({ error: "Missing path" }, 400);
    }
    const resolved = resolve(folderPath);
    const home = process.env.HOME ?? "/tmp";
    if (!resolved.startsWith(home) && !resolved.startsWith("/tmp")) {
      return c.json({ error: "Forbidden path" }, 403);
    }
    Bun.spawn(["open", resolved]);
    return c.json({ ok: true });
  });

  // ─── Legacy ────────────────────────────────────────────────────────

  app.get("/metrics", (c) => {
    const runs = rm.listRuns();
    if (runs.length === 0) return c.json({});
    return c.json(runs[0]!.metrics.getTotals());
  });

  // ─── WhatsApp Webhook ──────────────────────────────────────────────

  app.get("/webhook/whatsapp", (c) => {
    const wa = deps.botManager?.getWhatsAppAdapter();
    if (!wa) return c.text("WhatsApp bot non configuré", 404);

    const query: Record<string, string> = {};
    for (const [key, value] of new URL(c.req.url).searchParams) {
      query[key] = value;
    }
    return wa.handleVerification(query);
  });

  app.post("/webhook/whatsapp", async (c) => {
    const wa = deps.botManager?.getWhatsAppAdapter();
    if (!wa) return c.text("WhatsApp bot non configuré", 404);

    const body = await c.req.json();
    await wa.handleWebhook(body);
    return c.text("OK", 200);
  });

  return app;
}

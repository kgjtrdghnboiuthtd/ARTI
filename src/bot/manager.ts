import type { BotAdapter, BotMessage } from "./adapter.ts";
import type { RunManager } from "../core/run-manager.ts";
import type { EventBus } from "../core/events.ts";
import type { TaskResult } from "../core/types.ts";
import { TelegramAdapter } from "./telegram.ts";
import { WhatsAppAdapter } from "./whatsapp.ts";
import { join } from "path";
import { logger } from "../observability/logger.ts";

const log = logger.child("bot-manager");

interface ActiveChat {
  chatId: string;
  platform: "telegram" | "whatsapp";
  adapter: BotAdapter;
}

interface PendingQCM {
  projectId: string;
  questions: string[];
}

interface BotConfig {
  telegram?: { enabled: boolean; token: string };
  whatsapp?: { enabled: boolean; token: string; phone_id: string; verify_token: string };
}

export class BotManager {
  private adapters: BotAdapter[] = [];
  private runManager: RunManager;
  private globalEvents: EventBus;

  /** projectId -> chat info */
  private activeChats = new Map<string, ActiveChat>();
  /** chatId -> pending QCM waiting for answer */
  private pendingQCM = new Map<string, PendingQCM>();
  /** chatId -> projectId (reverse lookup for active run per chat) */
  private chatToProject = new Map<string, string>();

  private telegramAdapter: TelegramAdapter | null = null;
  private whatsappAdapter: WhatsAppAdapter | null = null;

  constructor(runManager: RunManager, globalEvents: EventBus) {
    this.runManager = runManager;
    this.globalEvents = globalEvents;
  }

  /** Get the WhatsApp adapter (for webhook routing in app.ts) */
  getWhatsAppAdapter(): WhatsAppAdapter | null {
    return this.whatsappAdapter;
  }

  /** Initialize and start bots based on config */
  async start(config: BotConfig): Promise<void> {
    // ─── Telegram ───────────────────────────────────────────────────
    if (config.telegram?.enabled) {
      const token = config.telegram.token || process.env.TELEGRAM_BOT_TOKEN || "";
      if (token) {
        this.telegramAdapter = new TelegramAdapter(token);
        this.telegramAdapter.setMessageHandler((msg) => this.handleMessage(msg));
        this.adapters.push(this.telegramAdapter);
        log.info("Adaptateur Telegram configuré");
      } else {
        log.warn("Telegram activé mais aucun token fourni");
      }
    }

    // ─── WhatsApp ───────────────────────────────────────────────────
    if (config.whatsapp?.enabled) {
      const token = config.whatsapp.token || process.env.WHATSAPP_TOKEN || "";
      const phoneId = config.whatsapp.phone_id || process.env.WHATSAPP_PHONE_ID || "";
      const verifyToken = config.whatsapp.verify_token || process.env.WHATSAPP_VERIFY_TOKEN || "";
      if (token && phoneId) {
        this.whatsappAdapter = new WhatsAppAdapter(token, phoneId, verifyToken);
        this.whatsappAdapter.setMessageHandler((msg) => this.handleMessage(msg));
        this.adapters.push(this.whatsappAdapter);
        log.info("Adaptateur WhatsApp configuré");
      } else {
        log.warn("WhatsApp activé mais configuration incomplète");
      }
    }

    // Démarrer tous les adaptateurs
    for (const adapter of this.adapters) {
      try {
        await adapter.start();
      } catch (err) {
        log.error(`Erreur démarrage ${adapter.name}`, { error: (err as Error).message });
      }
    }

    // S'abonner aux événements globaux
    this.subscribeToEvents();

    if (this.adapters.length > 0) {
      log.info("BotManager démarré", { adapters: this.adapters.map((a) => a.name) });
    }
  }

  /** Stop all bots */
  stop(): void {
    for (const adapter of this.adapters) {
      adapter.stop();
    }
    log.info("BotManager arrêté");
  }

  // ─── Message Handling ─────────────────────────────────────────────────

  private handleMessage(msg: BotMessage): void {
    log.info("Message reçu", { platform: msg.platform, from: msg.from, text: msg.text.slice(0, 50) });

    const text = msg.text.trim();

    // Vérifier si c'est une réponse QCM en attente
    if (this.pendingQCM.has(msg.chatId)) {
      this.handleQCMAnswer(msg);
      return;
    }

    // Parser les commandes
    if (text.startsWith("/")) {
      this.handleCommand(msg);
      return;
    }

    // Message texte simple -> nouveau projet
    this.startNewRun(msg);
  }

  private handleCommand(msg: BotMessage): void {
    const parts = msg.text.trim().split(/\s+/);
    const command = parts[0]!.toLowerCase();
    const args = parts.slice(1).join(" ");
    const adapter = this.getAdapter(msg.platform);
    if (!adapter) return;

    switch (command) {
      case "/run":
      case "/start": {
        if (!args) {
          adapter.sendMessage(msg.chatId, "Utilisation : /run <description du projet>\n\nExemple : /run Crée un site web portfolio");
          return;
        }
        this.startNewRun({ ...msg, text: args });
        break;
      }

      case "/status": {
        this.sendStatus(msg.chatId, adapter);
        break;
      }

      case "/stop": {
        this.stopActiveRun(msg.chatId, adapter);
        break;
      }

      case "/skills": {
        this.sendSkills(msg.chatId, adapter);
        break;
      }

      case "/help": {
        const helpText = [
          "*Commandes Arcti*",
          "",
          "/run <prompt> - Lancer un nouveau projet",
          "/status - Voir le statut du projet en cours",
          "/stop - Arrêter le projet en cours",
          "/skills - Lister les compétences apprises",
          "/help - Afficher cette aide",
          "",
          "Vous pouvez aussi envoyer un message texte directement pour lancer un nouveau projet.",
        ].join("\n");
        adapter.sendMessage(msg.chatId, helpText);
        break;
      }

      default: {
        adapter.sendMessage(msg.chatId, `Commande inconnue : ${command}\nTapez /help pour voir les commandes disponibles.`);
      }
    }
  }

  // ─── Run Management ─────────────────────────────────────────────────

  private startNewRun(msg: BotMessage): void {
    const adapter = this.getAdapter(msg.platform);
    if (!adapter) return;

    // Vérifier s'il y a déjà un projet actif pour ce chat
    const existingProjectId = this.chatToProject.get(msg.chatId);
    if (existingProjectId) {
      const existingRun = this.runManager.getRun(existingProjectId);
      if (existingRun && existingRun.status === "running") {
        adapter.sendMessage(
          msg.chatId,
          "Un projet est déjà en cours. Utilisez /stop pour l'arrêter avant d'en lancer un nouveau.",
        );
        return;
      }
      // Nettoyer l'ancien mapping
      this.chatToProject.delete(msg.chatId);
      this.activeChats.delete(existingProjectId);
    }

    try {
      // Auto-assign workDir for bot runs → ~/.arcti/outputs/<id>
      const outputBase = join(process.env.HOME ?? "/tmp", ".arcti", "outputs");
      const runId = crypto.randomUUID().slice(0, 8);
      const workDir = join(outputBase, runId);

      const run = this.runManager.createRun(msg.text, { source: msg.platform, workDir });
      this.activeChats.set(run.id, { chatId: msg.chatId, platform: msg.platform, adapter });
      this.chatToProject.set(msg.chatId, run.id);

      adapter.sendMessage(
        msg.chatId,
        [
          `*Projet lancé*`,
          `ID : \`${run.id}\``,
          `Entrée : ${msg.text.slice(0, 100)}${msg.text.length > 100 ? "..." : ""}`,
          "",
          "Analyse en cours... Je vous tiendrai informé de l'avancement.",
        ].join("\n"),
      );

      this.runManager.startRun(run);
      log.info("Projet démarré via bot", { projectId: run.id, platform: msg.platform, chatId: msg.chatId });
    } catch (err) {
      log.error("Erreur création projet via bot", { error: (err as Error).message });
      adapter.sendMessage(msg.chatId, `Erreur lors du lancement du projet : ${(err as Error).message}`);
    }
  }

  private sendStatus(chatId: string, adapter: BotAdapter): void {
    const projectId = this.chatToProject.get(chatId);
    if (!projectId) {
      adapter.sendMessage(chatId, "Aucun projet en cours pour cette conversation.");
      return;
    }

    const run = this.runManager.getRun(projectId);
    if (!run) {
      adapter.sendMessage(chatId, "Projet introuvable.");
      this.chatToProject.delete(chatId);
      return;
    }

    const results = [...run.state.results.values()];
    const completed = results.filter((r) => r.status === "verified").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const running = results.filter((r) => r.status === "running").length;
    const pending = results.filter((r) => r.status === "pending").length;
    const total = run.state.tasks.size;

    const statusEmoji = run.status === "running" ? "..." : run.status === "completed" ? "OK" : "ERREUR";

    const statusText = [
      `*Statut du projet* \`${run.id}\``,
      `Nom : ${run.name}`,
      `Statut : ${statusEmoji} ${run.status}`,
      "",
      `Tâches : ${total} au total`,
      `  - Terminées : ${completed}`,
      `  - En cours : ${running}`,
      `  - En attente : ${pending}`,
      `  - Échouées : ${failed}`,
    ].join("\n");

    adapter.sendMessage(chatId, statusText);
  }

  private stopActiveRun(chatId: string, adapter: BotAdapter): void {
    const projectId = this.chatToProject.get(chatId);
    if (!projectId) {
      adapter.sendMessage(chatId, "Aucun projet en cours à arrêter.");
      return;
    }

    const ok = this.runManager.stopRun(projectId);
    if (ok) {
      adapter.sendMessage(chatId, `Projet \`${projectId}\` arrêté.`);
      this.chatToProject.delete(chatId);
      this.activeChats.delete(projectId);
    } else {
      adapter.sendMessage(chatId, "Impossible d'arrêter le projet (peut-être déjà terminé).");
    }
  }

  private sendSkills(chatId: string, adapter: BotAdapter): void {
    const lib = this.runManager.getSkillLibrary();
    if (!lib) {
      adapter.sendMessage(chatId, "Bibliothèque de compétences non disponible.");
      return;
    }

    const skills = lib.list(false);
    if (skills.length === 0) {
      adapter.sendMessage(chatId, "Aucune compétence apprise pour le moment.");
      return;
    }

    const lines = skills.slice(0, 20).map((s) => {
      return `- *${s.definition.name}* : ${s.definition.description.slice(0, 80)}`;
    });

    adapter.sendMessage(chatId, `*Compétences apprises (${skills.length})*\n\n${lines.join("\n")}`);
  }

  // ─── QCM Handling ───────────────────────────────────────────────────

  private handleQCMAnswer(msg: BotMessage): void {
    const pending = this.pendingQCM.get(msg.chatId);
    if (!pending) return;

    this.pendingQCM.delete(msg.chatId);

    const ok = this.runManager.answerQuestions(pending.projectId, msg.text);
    if (ok) {
      const adapter = this.getAdapter(msg.platform);
      adapter?.sendMessage(msg.chatId, "Merci pour vos réponses ! Le projet continue...");
      log.info("Réponse QCM reçue via bot", { projectId: pending.projectId });
    }
  }

  // ─── Event Subscriptions ──────────────────────────────────────────────

  private subscribeToEvents(): void {
    // Questions d'intake
    this.globalEvents.on("project:intake-questions", (data) => {
      const { projectId, questions } = data as { projectId?: string; questions: string[] };
      if (!projectId) return;

      const chat = this.activeChats.get(projectId);
      if (!chat) return;

      // Stocker le QCM en attente
      this.pendingQCM.set(chat.chatId, { projectId, questions });

      const questionText = [
        "*Questions de clarification :*",
        "",
        ...questions.map((q, i) => `${i + 1}. ${q}`),
        "",
        "Répondez à ces questions en un seul message.",
      ].join("\n");

      chat.adapter.sendMessage(chat.chatId, questionText);
    });

    // Tâche terminée
    this.globalEvents.on("task:completed", (data) => {
      const { projectId, taskId } = data as { projectId?: string; taskId: string };
      if (!projectId) return;

      const chat = this.activeChats.get(projectId);
      if (!chat) return;

      const run = this.runManager.getRun(projectId);
      if (!run) return;

      const task = run.state.tasks.get(taskId);
      const results = [...run.state.results.values()];
      const completed = results.filter((r) => r.status === "verified" || r.status === "completed").length;
      const total = run.state.tasks.size;

      if (task && total > 0) {
        chat.adapter.sendMessage(
          chat.chatId,
          `Tâche terminée : *${task.name}* (${completed}/${total})`,
        );
      }
    });

    // Tâche échouée
    this.globalEvents.on("task:failed", (data) => {
      const { projectId, taskId } = data as { projectId?: string; taskId: string };
      if (!projectId) return;

      const chat = this.activeChats.get(projectId);
      if (!chat) return;

      const run = this.runManager.getRun(projectId);
      if (!run) return;

      const task = run.state.tasks.get(taskId);
      if (task) {
        chat.adapter.sendMessage(
          chat.chatId,
          `Tâche échouée : *${task.name}*\nLe système va tenter de continuer.`,
        );
      }
    });

    // Projet terminé
    this.globalEvents.on("project:complete", async (data) => {
      const { projectId, results: taskResults, totalTokens } = data as {
        projectId?: string;
        results: TaskResult[];
        totalTokens: { promptTokens: number; completionTokens: number };
      };
      if (!projectId) return;

      const chat = this.activeChats.get(projectId);
      if (!chat) return;

      const run = this.runManager.getRun(projectId);
      if (!run) return;

      const verified = (taskResults ?? []).filter((r) => r.status === "verified").length;
      const failed = (taskResults ?? []).filter((r) => r.status === "failed").length;
      const totalTasks = run.state.tasks.size;

      const completionText = [
        "✅ *Projet terminé !*",
        "",
        `📊 Tâches : ${verified} réussies / ${totalTasks} au total${failed > 0 ? ` (${failed} échouées)` : ""}`,
        totalTokens ? `🔢 Tokens : ${totalTokens.promptTokens + totalTokens.completionTokens}` : "",
      ].filter(Boolean).join("\n");

      chat.adapter.sendMessage(chat.chatId, completionText);

      // Send a preview of output.md content
      this.sendResultPreview(chat, run);

      // Send artifact files
      if (run.artifacts.length > 0) {
        // Send output.md first (main result), then other files
        const outputMd = run.artifacts.find(a => a.endsWith("output.md"));
        const others = run.artifacts.filter(a => !a.endsWith("output.md"));

        if (outputMd) {
          await chat.adapter.sendFile(chat.chatId, outputMd, "📄 Résultat complet (output.md)");
        }
        for (const artifact of others.slice(0, 10)) {
          const name = artifact.split("/").pop() ?? "fichier";
          await chat.adapter.sendFile(chat.chatId, artifact, `📎 ${name}`);
        }

        if (run.workDir) {
          chat.adapter.sendMessage(chat.chatId, `📁 Tous les fichiers : \`${run.workDir}\``);
        }
      }

      // Nettoyer les mappings
      this.chatToProject.delete(chat.chatId);
      this.activeChats.delete(projectId);
    });

    // Projet avorté
    this.globalEvents.on("project:aborted", (data) => {
      const { projectId, reason } = data as { projectId?: string; reason: string };
      if (!projectId) return;

      const chat = this.activeChats.get(projectId);
      if (!chat) return;

      chat.adapter.sendMessage(chat.chatId, `*Projet arrêté*\nRaison : ${reason}`);

      this.chatToProject.delete(chat.chatId);
      this.activeChats.delete(projectId);
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Send a text preview of the final result (first ~1000 chars of output.md) */
  private async sendResultPreview(chat: ActiveChat, run: any): Promise<void> {
    try {
      const outputPath = run.artifacts?.find((a: string) => a.endsWith("output.md"));
      if (!outputPath) return;

      const file = Bun.file(outputPath);
      if (!(await file.exists())) return;

      const content = await file.text();
      if (!content) return;

      // Clean up markdown for chat: remove code block markers with filenames
      let preview = content
        .replace(/```\w*#[^\n]+\n/g, "--- fichier ---\n")
        .replace(/```\w*\n/g, "")
        .replace(/```/g, "");

      // Truncate to ~1500 chars
      if (preview.length > 1500) {
        preview = preview.slice(0, 1500) + "\n\n[...tronqué, voir le fichier complet]";
      }

      chat.adapter.sendMessage(chat.chatId, `📝 *Aperçu du résultat :*\n\n${preview}`);
    } catch (err) {
      log.warn("Could not send result preview", { error: (err as Error).message });
    }
  }

  private getAdapter(platform: "telegram" | "whatsapp"): BotAdapter | null {
    if (platform === "telegram") return this.telegramAdapter;
    if (platform === "whatsapp") return this.whatsappAdapter;
    return null;
  }
}

import type { BotAdapter, BotMessage } from "./adapter.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child("telegram");

const TELEGRAM_API = "https://api.telegram.org/bot";

export class TelegramAdapter implements BotAdapter {
  readonly name = "telegram";
  private token: string;
  private baseUrl: string;
  private offset = 0;
  private running = false;
  private abortController: AbortController | null = null;
  private onMessage: ((msg: BotMessage) => void) | null = null;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = `${TELEGRAM_API}${token}`;
  }

  /** Set handler for incoming messages */
  setMessageHandler(handler: (msg: BotMessage) => void): void {
    this.onMessage = handler;
  }

  async start(): Promise<void> {
    if (!this.token) {
      log.warn("Token Telegram manquant, bot non démarré");
      return;
    }

    // Vérifier la connexion
    try {
      const res = await fetch(`${this.baseUrl}/getMe`);
      const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
      if (!data.ok) {
        log.error("Impossible de se connecter à l'API Telegram");
        return;
      }
      log.info("Bot Telegram connecté", { username: data.result?.username });
    } catch (err) {
      log.error("Erreur connexion Telegram", { error: (err as Error).message });
      return;
    }

    this.running = true;
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    log.info("Bot Telegram arrêté");
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      // Telegram MarkdownV2 a une limite de 4096 caractères
      const chunks = splitMessage(text, 4000);
      for (const chunk of chunks) {
        const res = await fetch(`${this.baseUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: "Markdown",
          }),
        });

        if (!res.ok) {
          // Réessayer sans formatage si Markdown échoue
          const errBody = await res.text();
          log.warn("Erreur envoi Markdown, réessai en texte brut", { error: errBody });
          await fetch(`${this.baseUrl}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
            }),
          });
        }
      }
    } catch (err) {
      log.error("Erreur envoi message Telegram", { chatId, error: (err as Error).message });
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        log.warn("Fichier introuvable pour envoi", { filePath });
        return;
      }

      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append("document", file, filePath.split("/").pop() ?? "file");
      if (caption) {
        formData.append("caption", caption.slice(0, 1024));
      }

      const res = await fetch(`${this.baseUrl}/sendDocument`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errBody = await res.text();
        log.error("Erreur envoi fichier Telegram", { chatId, error: errBody });
      }
    } catch (err) {
      log.error("Erreur envoi fichier Telegram", { chatId, filePath, error: (err as Error).message });
    }
  }

  // ─── Long Polling ───────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        this.abortController = new AbortController();
        const url = `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=30&allowed_updates=["message"]`;

        const res = await fetch(url, {
          signal: this.abortController.signal,
        });

        if (!res.ok) {
          log.error("Erreur polling Telegram", { status: res.status });
          await Bun.sleep(5000);
          continue;
        }

        const data = (await res.json()) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              chat: { id: number };
              from?: { first_name?: string; username?: string };
              text?: string;
            };
          }>;
        };

        if (!data.ok || !data.result?.length) continue;

        for (const update of data.result) {
          this.offset = update.update_id + 1;

          if (update.message?.text && this.onMessage) {
            const msg: BotMessage = {
              chatId: String(update.message.chat.id),
              text: update.message.text,
              from: update.message.from?.first_name ?? update.message.from?.username ?? "inconnu",
              platform: "telegram",
            };
            this.onMessage(msg);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        log.error("Erreur polling Telegram", { error: (err as Error).message });
        await Bun.sleep(5000);
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Couper au dernier saut de ligne avant la limite
    let cutIndex = remaining.lastIndexOf("\n", maxLen);
    if (cutIndex <= 0) cutIndex = maxLen;
    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex);
  }
  return chunks;
}

// ─── Telegram Markdown Formatting ────────────────────────────────────────────

export function formatTelegramMessage(text: string): string {
  return text;
}

export function telegramBold(text: string): string {
  return `*${text}*`;
}

export function telegramCode(text: string): string {
  return `\`${text}\``;
}

export function telegramCodeBlock(text: string, lang = ""): string {
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

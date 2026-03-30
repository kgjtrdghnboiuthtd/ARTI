import type { BotAdapter, BotMessage } from "./adapter.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child("whatsapp");

const GRAPH_API = "https://graph.facebook.com/v18.0";

export class WhatsAppAdapter implements BotAdapter {
  readonly name = "whatsapp";
  private token: string;
  private phoneId: string;
  private verifyToken: string;
  private onMessage: ((msg: BotMessage) => void) | null = null;

  constructor(token: string, phoneId: string, verifyToken: string) {
    this.token = token;
    this.phoneId = phoneId;
    this.verifyToken = verifyToken;
  }

  /** Set handler for incoming messages */
  setMessageHandler(handler: (msg: BotMessage) => void): void {
    this.onMessage = handler;
  }

  async start(): Promise<void> {
    if (!this.token || !this.phoneId) {
      log.warn("Configuration WhatsApp incomplète, bot non démarré");
      return;
    }
    log.info("Bot WhatsApp démarré (webhook mode)", { phoneId: this.phoneId });
  }

  stop(): void {
    log.info("Bot WhatsApp arrêté");
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      // WhatsApp a une limite de ~4096 caractères par message
      const chunks = splitMessage(text, 4000);
      for (const chunk of chunks) {
        const res = await fetch(`${GRAPH_API}/${this.phoneId}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: chatId,
            type: "text",
            text: { body: chunk },
          }),
        });

        if (!res.ok) {
          const errBody = await res.text();
          log.error("Erreur envoi message WhatsApp", { chatId, error: errBody });
        }
      }
    } catch (err) {
      log.error("Erreur envoi message WhatsApp", { chatId, error: (err as Error).message });
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        log.warn("Fichier introuvable pour envoi", { filePath });
        return;
      }

      // Étape 1 : uploader le media
      const formData = new FormData();
      formData.append("messaging_product", "whatsapp");
      formData.append("file", file, filePath.split("/").pop() ?? "file");
      formData.append("type", file.type || "application/octet-stream");

      const uploadRes = await fetch(`${GRAPH_API}/${this.phoneId}/media`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
        },
        body: formData,
      });

      if (!uploadRes.ok) {
        const errBody = await uploadRes.text();
        log.error("Erreur upload media WhatsApp", { error: errBody });
        return;
      }

      const uploadData = (await uploadRes.json()) as { id?: string };
      if (!uploadData.id) {
        log.error("Pas d'ID media retourné par WhatsApp");
        return;
      }

      // Étape 2 : envoyer le document avec l'ID media
      const sendRes = await fetch(`${GRAPH_API}/${this.phoneId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: chatId,
          type: "document",
          document: {
            id: uploadData.id,
            caption: caption?.slice(0, 1024) ?? undefined,
            filename: filePath.split("/").pop() ?? "file",
          },
        }),
      });

      if (!sendRes.ok) {
        const errBody = await sendRes.text();
        log.error("Erreur envoi document WhatsApp", { chatId, error: errBody });
      }
    } catch (err) {
      log.error("Erreur envoi fichier WhatsApp", { chatId, filePath, error: (err as Error).message });
    }
  }

  // ─── Webhook Handling ─────────────────────────────────────────────────

  /** Handle GET webhook verification (called by app.ts route) */
  handleVerification(query: Record<string, string>): Response {
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === this.verifyToken) {
      log.info("Webhook WhatsApp vérifié");
      return new Response(challenge, { status: 200 });
    }

    log.warn("Vérification webhook WhatsApp échouée", { mode, token: token?.slice(0, 5) });
    return new Response("Forbidden", { status: 403 });
  }

  /** Handle POST webhook incoming message (called by app.ts route) */
  async handleWebhook(body: unknown): Promise<void> {
    try {
      const data = body as {
        entry?: Array<{
          changes?: Array<{
            value?: {
              messages?: Array<{
                from?: string;
                text?: { body?: string };
                type?: string;
              }>;
              contacts?: Array<{
                profile?: { name?: string };
              }>;
            };
          }>;
        }>;
      };

      if (!data.entry) return;

      for (const entry of data.entry) {
        for (const change of entry.changes ?? []) {
          const messages = change.value?.messages ?? [];
          const contacts = change.value?.contacts ?? [];

          for (const message of messages) {
            if (message.type !== "text" || !message.text?.body || !message.from) continue;

            const contactName = contacts[0]?.profile?.name ?? "inconnu";
            const msg: BotMessage = {
              chatId: message.from,
              text: message.text.body,
              from: contactName,
              platform: "whatsapp",
            };

            if (this.onMessage) {
              this.onMessage(msg);
            }
          }
        }
      }
    } catch (err) {
      log.error("Erreur traitement webhook WhatsApp", { error: (err as Error).message });
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
    let cutIndex = remaining.lastIndexOf("\n", maxLen);
    if (cutIndex <= 0) cutIndex = maxLen;
    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex);
  }
  return chunks;
}

// ─── WhatsApp Formatting ─────────────────────────────────────────────────────

export function whatsappBold(text: string): string {
  return `*${text}*`;
}

export function whatsappItalic(text: string): string {
  return `_${text}_`;
}

export function whatsappCode(text: string): string {
  return `\`\`\`${text}\`\`\``;
}

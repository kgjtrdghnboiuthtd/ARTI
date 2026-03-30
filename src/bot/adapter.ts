// ─── Bot Adapter Interface ──────────────────────────────────────────────────

export interface BotAdapter {
  name: string;
  start(): Promise<void>;
  stop(): void;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
}

export interface BotMessage {
  chatId: string;
  text: string;
  from: string;
  platform: "telegram" | "whatsapp";
}

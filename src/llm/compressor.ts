import type { LLMClient } from "./client.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child("compressor");

const COMPRESS_PROMPT = `Condense le texte suivant en gardant TOUT le contenu utile.

RÈGLES CRITIQUES :
- Garde INTÉGRALEMENT tout le code, les poèmes, les textes créatifs, les données structurées
- Garde INTÉGRALEMENT les listes, les résultats, les choix et les décisions
- Supprime uniquement les explications redondantes, les introductions inutiles, et les reformulations
- Ne résume JAMAIS le contenu créatif ou les blocs de code — copie-les tels quels
- Réponds uniquement avec le texte condensé, sans commentaire ni introduction`;

// ~4 chars per token on average
const CHAR_THRESHOLD = 8000; // ~2000 tokens

/**
 * Compress context text if it exceeds the threshold.
 * Uses the cheapest model available.
 */
export async function compressContext(
  text: string,
  model: string,
  llm: LLMClient,
): Promise<string> {
  if (text.length <= CHAR_THRESHOLD) return text;

  log.info(`Compressing context (${text.length} chars → summarizing)`);

  try {
    const response = await llm.complete(
      [
        { role: "system", content: COMPRESS_PROMPT },
        { role: "user", content: text },
      ],
      model,
      { temperature: 0.3, maxTokens: 1024 },
    );

    log.info(
      `Compressed: ${text.length} → ${response.content.length} chars`,
    );
    return response.content;
  } catch (error) {
    log.warn(`Compression failed, using original: ${(error as Error).message}`);
    return text;
  }
}

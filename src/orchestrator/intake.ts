import type { ProjectBrief, LLMMessage } from "../core/types.ts";
import { BaseAgent, type AgentContext } from "../agents/base.ts";

const INTAKE_SYSTEM_PROMPT = `Analyse la demande utilisateur. Identifie les gaps selon QQOQCP (Qui/Quoi/Quand/Comment/Pourquoi/Combien).

JSON uniquement :
{"hasEnoughInfo":bool,"questions":["..."],"brief":{"objective":"","targetAudience":"","constraints":[],"timeline":null,"motivation":null,"budgetScope":null,"successCriteria":[]}}

RÈGLES STRICTES :
- Max 3 questions, seulement si ABSOLUMENT indispensables pour commencer le travail
- hasEnoughInfo=true si la demande est suffisamment claire pour agir (même si tout n'est pas précisé)
- Si l'utilisateur a déjà répondu à des questions, hasEnoughInfo DOIT être true (ne pose PAS de nouvelles questions)
- Préfère agir avec les infos disponibles plutôt que de poser trop de questions
- "" pour les champs inconnus`;

interface IntakeResponse {
  hasEnoughInfo: boolean;
  questions: string[];
  brief: {
    objective: string;
    targetAudience: string;
    constraints: string[];
    timeline: string | null;
    motivation: string | null;
    budgetScope: string | null;
    successCriteria: string[];
  };
}

export class IntakeAgent extends BaseAgent {
  private conversationHistory: LLMMessage[] = [];

  constructor(ctx: AgentContext) {
    super("intake", INTAKE_SYSTEM_PROMPT, ctx);
  }

  /**
   * Analyze user input and return either questions to ask or a complete brief.
   */
  async analyze(
    userInput: string,
    model: string,
  ): Promise<{
    needsMore: boolean;
    questions: string[];
    brief: ProjectBrief | null;
  }> {
    this.conversationHistory.push({ role: "user", content: userInput });

    const { parsed, response: _ } = await this.callJSON<IntakeResponse>(
      this.conversationHistory
        .map((m) => `[${m.role}]: ${m.content}`)
        .join("\n"),
      model,
    );

    this.conversationHistory.push({
      role: "assistant",
      content: JSON.stringify(parsed),
    });

    if (parsed.hasEnoughInfo || parsed.questions.length === 0) {
      return {
        needsMore: false,
        questions: [],
        brief: {
          ...parsed.brief,
          timeline: parsed.brief.timeline ?? undefined,
          motivation: parsed.brief.motivation ?? undefined,
          budgetScope: parsed.brief.budgetScope ?? undefined,
          rawUserInput: userInput,
        },
      };
    }

    return {
      needsMore: true,
      questions: parsed.questions,
      brief: null,
    };
  }

  /**
   * Feed additional answers from the user and re-analyze.
   */
  async refine(
    answers: string,
    model: string,
  ): Promise<{
    needsMore: boolean;
    questions: string[];
    brief: ProjectBrief | null;
  }> {
    return this.analyze(answers, model);
  }
}

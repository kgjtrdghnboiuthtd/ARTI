import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { join } from "path";

// ─── Provider Names ────────────────────────────────────────────────────────

export type ProviderName =
  | "ollama"
  | "anthropic"
  | "openai"
  | "grok"
  | "openrouter"
  | "claude-code";

// ─── Config Types ───────────────────────────────────────────────────────────

export interface ModelTierConfig {
  provider: "local" | "cloud";
  model: string;
}

export interface ProviderConfig {
  enabled: boolean;
  apiKeyEnv?: string;
  baseUrl?: string;
}

export interface ArctiConfig {
  // Legacy — still supported for backward compat
  providerMode?: "local" | "cloud" | "hybrid";

  // New multi-provider system
  defaultProvider: ProviderName;
  defaultModels: { tier1: string; tier2: string; tier3: string };

  providers: {
    ollama: ProviderConfig & { baseUrl: string; mode: "local" | "cloud" | "both" };
    anthropic: ProviderConfig;
    openai: ProviderConfig;
    grok: ProviderConfig & { baseUrl: string };
    openrouter: ProviderConfig & { baseUrl: string };
    "claude-code": ProviderConfig;
  };

  // Legacy sections (kept for backward compat)
  local: {
    baseUrl: string;
    models: { tier1: string; tier2: string; tier3: string };
  };
  cloud: {
    provider: "anthropic" | "openai";
    apiKeyEnv: string;
    baseUrl?: string;
    models: { tier1: string; tier2: string; tier3: string };
  };
  hybrid: {
    tier1: ModelTierConfig;
    tier2: ModelTierConfig;
    tier3: ModelTierConfig;
  };

  scheduler: { maxConcurrency: number };
  recursion: { maxDepth: number; maxTotalTasks: number };
  server: { port: number; host: string };
}

// ─── Provider model defaults ────────────────────────────────────────────────

export const PROVIDER_MODELS: Record<ProviderName, string[]> = {
  ollama: ["gemma3:12b", "qwen2.5:3b", "llama3.1:70b"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6"],
  openai: ["gpt-4o-mini", "gpt-4o", "o3"],
  grok: ["grok-3-mini", "grok-3"],
  openrouter: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o", "google/gemini-2.5-pro"],
  "claude-code": ["haiku", "sonnet", "opus"],
};

export const PROVIDER_DEFAULT_TIERS: Record<ProviderName, { tier1: string; tier2: string; tier3: string }> = {
  ollama: { tier1: "qwen2.5:3b", tier2: "gemma3:12b", tier3: "llama3.1:70b" },
  anthropic: { tier1: "claude-haiku-4-5-20251001", tier2: "claude-sonnet-4-6", tier3: "claude-opus-4-6" },
  openai: { tier1: "gpt-4o-mini", tier2: "gpt-4o", tier3: "o3" },
  grok: { tier1: "grok-3-mini", tier2: "grok-3", tier3: "grok-3" },
  openrouter: { tier1: "anthropic/claude-haiku-4-5-20251001", tier2: "anthropic/claude-sonnet-4-6", tier3: "anthropic/claude-opus-4-6" },
  "claude-code": { tier1: "haiku", tier2: "sonnet", tier3: "opus" },
};

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULTS: ArctiConfig = {
  defaultProvider: "ollama",
  defaultModels: { ...PROVIDER_DEFAULT_TIERS["ollama"] },

  providers: {
    ollama: { enabled: true, baseUrl: "http://localhost:11434", mode: "both" as const },
    anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY" },
    openai: { enabled: false, apiKeyEnv: "OPENAI_API_KEY" },
    grok: { enabled: false, apiKeyEnv: "XAI_API_KEY", baseUrl: "https://api.x.ai" },
    openrouter: { enabled: false, apiKeyEnv: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api" },
    "claude-code": { enabled: false },
  },

  local: {
    baseUrl: "http://localhost:11434",
    models: { tier1: "qwen2.5:3b", tier2: "gemma3:12b", tier3: "llama3.1:70b" },
  },
  cloud: {
    provider: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: { tier1: "claude-haiku-4-5-20251001", tier2: "claude-sonnet-4-6", tier3: "claude-opus-4-6" },
  },
  hybrid: {
    tier1: { provider: "local", model: "qwen2.5:3b" },
    tier2: { provider: "local", model: "gemma3:12b" },
    tier3: { provider: "cloud", model: "claude-sonnet-4-6" },
  },

  scheduler: { maxConcurrency: 4 },
  recursion: { maxDepth: 4, maxTotalTasks: 50 },
  server: { port: 3000, host: "localhost" },
};

// ─── Load Config ────────────────────────────────────────────────────────────

export function loadConfig(configPath?: string): ArctiConfig {
  const paths = configPath
    ? [configPath]
    : [
        join(process.cwd(), "arcti.yaml"),
        join(process.cwd(), "arcti.yml"),
        join(process.cwd(), "config.yaml"),
      ];

  let config = { ...DEFAULTS };

  for (const p of paths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      const parsed = parseYaml(raw) as Record<string, unknown>;
      config = deepMerge(DEFAULTS, camelCaseKeys(parsed) as Partial<ArctiConfig>) as ArctiConfig;
      break;
    }
  }

  // Backward compat: migrate old providerMode to new system
  if (config.providerMode && !config.defaultProvider) {
    config = migrateFromLegacy(config);
  }

  return config;
}

/** Migrate old providerMode config to new multi-provider system */
function migrateFromLegacy(config: ArctiConfig): ArctiConfig {
  const mode = config.providerMode;

  if (mode === "local") {
    config.defaultProvider = "ollama";
    config.defaultModels = config.local.models;
    config.providers.ollama.enabled = true;
    config.providers.ollama.baseUrl = config.local.baseUrl;
  } else if (mode === "cloud") {
    config.defaultProvider = config.cloud.provider === "openai" ? "openai" : "anthropic";
    config.defaultModels = config.cloud.models;
    if (config.cloud.provider === "openai") {
      config.providers.openai.enabled = true;
    } else {
      config.providers.anthropic.enabled = true;
    }
  } else if (mode === "hybrid") {
    config.defaultProvider = "ollama";
    config.providers.ollama.enabled = true;
    config.providers.anthropic.enabled = true;
    config.defaultModels = {
      tier1: config.hybrid.tier1.model,
      tier2: config.hybrid.tier2.model,
      tier3: config.hybrid.tier3.model,
    };
  }

  return config;
}

// ─── Runtime config update ──────────────────────────────────────────────────

/** Update config at runtime (from Settings UI). Returns the updated config. */
export function applySettingsUpdate(
  config: ArctiConfig,
  update: {
    defaultProvider?: ProviderName;
    defaultModels?: Partial<ArctiConfig["defaultModels"]>;
    ollamaMode?: "local" | "cloud" | "both";
  },
): ArctiConfig {
  if (update.defaultProvider) {
    config.defaultProvider = update.defaultProvider;
  }
  if (update.defaultModels) {
    Object.assign(config.defaultModels, update.defaultModels);
  }
  if (update.ollamaMode) {
    config.providers.ollama.mode = update.ollamaMode;
  }
  return config;
}

// ─── Utils ──────────────────────────────────────────────────────────────────

function camelCaseKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(camelCaseKeys);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      result[camelKey] = camelCaseKeys(value);
    }
    return result;
  }
  return obj;
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (
    source === null ||
    source === undefined ||
    typeof source !== "object" ||
    typeof target !== "object" ||
    target === null
  ) {
    return source ?? target;
  }

  if (Array.isArray(source)) return source;

  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = deepMerge(result[key], value);
    }
  }
  return result;
}

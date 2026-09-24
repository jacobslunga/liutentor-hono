export type Provider = "openai";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ModelConfig {
  provider: Provider;
  modelId: string;
  effort: ReasoningEffort;
  /** The deep tier remains protected from anonymous abuse. */
  requiresAuth?: boolean;
  /** Keep tool support explicit so a future tier cannot silently 400. */
  supportsWebSearch?: boolean;
}

export const LUNA_CHAT_MODEL_ID = "gpt-6-luna";
export const SOL_CHAT_MODEL_ID = "gpt-6-sol";

export const CHAT_TIER_IDS = {
  low: "gpt-6-luna-low",
  balanced: "gpt-6-luna-high",
  deep: "gpt-6-sol-low",
} as const;

/** The public selection ID used when a client omits or sends an unknown tier. */
export const DEFAULT_MODEL_ID = CHAT_TIER_IDS.low;

const LOW_CONFIG: ModelConfig = {
  provider: "openai",
  modelId: LUNA_CHAT_MODEL_ID,
  effort: "low",
  supportsWebSearch: true,
};

const BALANCED_CONFIG: ModelConfig = {
  provider: "openai",
  modelId: LUNA_CHAT_MODEL_ID,
  effort: "high",
  supportsWebSearch: true,
};

const DEEP_CONFIG: ModelConfig = {
  provider: "openai",
  modelId: SOL_CHAT_MODEL_ID,
  effort: "low",
  requiresAuth: true,
  supportsWebSearch: true,
};

const MODEL_MAP: Record<string, ModelConfig> = {
  [CHAT_TIER_IDS.low]: LOW_CONFIG,
  [CHAT_TIER_IDS.balanced]: BALANCED_CONFIG,
  [CHAT_TIER_IDS.deep]: DEEP_CONFIG,

  // Compatibility aliases let the Hono service deploy before the Nuxt client.
  // They can be removed after old bundles and cookies have aged out.
  "gemini-flash-lite-minimal": LOW_CONFIG,
  "gemini-flash-lite-medium": BALANCED_CONFIG,
  "gemini-flash-lite-high": DEEP_CONFIG,
  "gemini-3.1-flash-lite": LOW_CONFIG,
  "gpt-6-luna": LOW_CONFIG,
  "gpt-6-sol": DEEP_CONFIG,
  // Compatibility for clients that sent the previous concrete model IDs.
  "gpt-5.6-luna": BALANCED_CONFIG,
  "gpt-5.6-terra": DEEP_CONFIG,
};

export const getModelConfig = (modelId?: string): ModelConfig =>
  (modelId ? MODEL_MAP[modelId] : undefined) ?? LOW_CONFIG;

export const getModelLogId = (config: ModelConfig): string =>
  `${config.modelId}:${config.effort}`;

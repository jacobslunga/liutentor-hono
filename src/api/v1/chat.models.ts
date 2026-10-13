export type Provider = "openai" | "anthropic" | "google";
export type ReasoningEffort = "low" | "medium" | "high";

export const CHAT_EFFORTS = ["low", "medium", "high"] as const;

export interface ModelConfig {
  provider: Provider;
  modelId: string;
  effort: ReasoningEffort;
  requiresAuth?: boolean;
  supportsWebSearch?: boolean;
}

export const LUNA_CHAT_MODEL_ID = "gpt-6-luna";
export const HAIKU_CHAT_MODEL_ID = "claude-haiku-5-5";
export const GEMINI_CHAT_MODEL_ID = "gemini-3.1-flash-lite";

export const CHAT_MODEL_IDS = [
  HAIKU_CHAT_MODEL_ID,
  LUNA_CHAT_MODEL_ID,
  GEMINI_CHAT_MODEL_ID,
] as const;
export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];

const MODEL_PROVIDERS = {
  [HAIKU_CHAT_MODEL_ID]: "anthropic",
  [LUNA_CHAT_MODEL_ID]: "openai",
  [GEMINI_CHAT_MODEL_ID]: "google",
} satisfies Record<ChatModelId, Provider>;

export function getModelConfig(
  modelId: ChatModelId,
  effort: ReasoningEffort = "low",
): ModelConfig {
  const provider = MODEL_PROVIDERS[modelId];
  if (!provider) throw new Error("Unsupported chat model");
  return {
    provider,
    modelId,
    effort,
    // Only the deepest reasoning level is reserved for signed-in users.
    ...(effort === "high" ? { requiresAuth: true } : {}),
    supportsWebSearch: true,
  };
}

export const getModelLogId = (config: ModelConfig): string =>
  `${config.modelId}:${config.effort}`;

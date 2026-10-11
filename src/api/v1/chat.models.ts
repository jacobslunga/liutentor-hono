export type Provider = "openai";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ModelConfig {
  provider: Provider;
  modelId: string;
  effort: ReasoningEffort;
  requiresAuth?: boolean;
  supportsWebSearch?: boolean;
}

export const LUNA_CHAT_MODEL_ID = "gpt-6-luna";
export const SOL_CHAT_MODEL_ID = "gpt-6.1-sol";
export const CHAT_MODEL_IDS = [
  LUNA_CHAT_MODEL_ID,
  SOL_CHAT_MODEL_ID,
] as const;
export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];

export const MODEL_MAP = {
  fast: {
    provider: "openai",
    modelId: LUNA_CHAT_MODEL_ID,
    effort: "low",
    supportsWebSearch: true,
  },
  thinking: {
    provider: "openai",
    modelId: SOL_CHAT_MODEL_ID,
    effort: "low",
    requiresAuth: true,
    supportsWebSearch: true,
  },
} satisfies Record<"fast" | "thinking", ModelConfig>;

export function getModelConfig(modelId: ChatModelId): ModelConfig {
  const config = Object.values(MODEL_MAP).find(
    (model) => model.modelId === modelId,
  );
  if (!config) throw new Error("Unsupported chat model");
  return config;
}

export const getModelLogId = (config: ModelConfig): string =>
  `${config.modelId}:${config.effort}`;

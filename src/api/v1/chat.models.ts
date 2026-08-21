export type Provider = "anthropic" | "google" | "openai";

export interface ModelConfig {
  provider: Provider;
  modelId: string;
  /**
   * Tiers that cost enough to be worth abusing are gated behind a real account.
   * The UI hides them for signed-out visitors; this flag is what actually
   * enforces it, since the UI is not a security boundary.
   */
  requiresAuth?: boolean;
}

export const DEFAULT_MODEL_ID = "gpt-5.6-luna";

const MODEL_MAP: Record<string, ModelConfig> = {
  "gemini-3.1-flash-lite": {
    provider: "google",
    modelId: "gemini-3.1-flash-lite",
  },
  "gpt-5.6-luna": {
    provider: "openai",
    modelId: "gpt-5.6-luna",
  },
  "gpt-5.6-terra": {
    provider: "openai",
    modelId: "gpt-5.6-terra",
    requiresAuth: true,
  },
};

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai",
  modelId: DEFAULT_MODEL_ID,
};

export const getModelConfig = (modelId?: string): ModelConfig =>
  (modelId ? MODEL_MAP[modelId] : undefined) ?? DEFAULT_MODEL_CONFIG;

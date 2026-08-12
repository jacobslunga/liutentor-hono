export type Provider = "anthropic" | "google" | "openai";

export interface ModelConfig {
  provider: Provider;
  modelId: string;
}

export const DEFAULT_MODEL_ID = "gpt-5.6-luna";

const MODEL_MAP: Record<string, ModelConfig> = {
  "gemini-3.1-flash-lite": {
    provider: "google",
    modelId: "gemini-3.1-flash-lite",
  },
  "gemini-3.6-flash": {
    provider: "google",
    modelId: "gemini-3.6-flash",
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
  },
  "claude-sonnet-4-6": {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  },
  "gpt-5.6-terra": {
    provider: "openai",
    modelId: "gpt-5.6-terra",
  },
  "gpt-5.6-luna": {
    provider: "openai",
    modelId: "gpt-5.6-luna",
  },
};

export const getModelConfig = (modelId?: string): ModelConfig =>
  (modelId && MODEL_MAP[modelId]) ?? {
    provider: "openai",
    modelId: DEFAULT_MODEL_ID,
  };

import { z } from "zod";

export const llmProviderSchema = z.enum(["openai", "anthropic", "google"]);

export type LlmProvider = z.infer<typeof llmProviderSchema>;

export type DefaultLlmSettings = {
  provider: LlmProvider;
  model: string;
};

export function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function requireEnv(name: string): string {
  const value = getEnv(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getDefaultLlmSettings(): DefaultLlmSettings {
  const provider = llmProviderSchema.parse(
    getEnv("DEFAULT_LLM_PROVIDER") ?? "openai",
  );

  return {
    provider,
    model: getEnv("DEFAULT_LLM_MODEL") ?? "gpt-4.1",
  };
}

import type { LlmProvider } from "@/lib/env";

export type GenerateTextRequest = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw?: unknown;
};

export type GenerateTextResult = {
  provider: LlmProvider;
  model: string;
  text: string;
  usage?: LlmUsage;
  estimatedCostUsd?: number | null;
};

export type LlmClient = {
  provider: LlmProvider;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
};

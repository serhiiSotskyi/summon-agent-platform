import type { LlmProvider } from "@/lib/env";

export type GenerateTextRequest = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
};

export type GenerateTextResult = {
  provider: LlmProvider;
  model: string;
  text: string;
};

export type LlmClient = {
  provider: LlmProvider;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
};

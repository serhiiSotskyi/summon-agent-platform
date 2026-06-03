import {
  getDefaultLlmSettings,
  getEnv,
  type LlmProvider,
  requireEnv,
} from "@/lib/env";
import type { GenerateTextRequest, GenerateTextResult, LlmClient } from "./types";

function combinePrompt(request: GenerateTextRequest) {
  if (!request.systemPrompt) {
    return request.prompt;
  }

  return `${request.systemPrompt}\n\n${request.prompt}`;
}

function resolveModel(provider: LlmProvider, requestedModel?: string) {
  if (requestedModel) {
    return requestedModel;
  }

  const defaults = getDefaultLlmSettings();
  if (defaults.provider === provider) {
    return defaults.model;
  }

  if (provider === "openai") {
    return "gpt-4.1";
  }

  if (provider === "anthropic") {
    return "claude-sonnet-4-5";
  }

  return "gemini-2.5-pro";
}

class OpenAiLlmClient implements LlmClient {
  provider = "openai" as const;

  async generateText(
    request: GenerateTextRequest,
  ): Promise<GenerateTextResult> {
    const { default: OpenAI } = await import("openai");
    const model = resolveModel(this.provider, request.model);
    const client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

    const response = await client.responses.create({
      model,
      input: combinePrompt(request),
    });

    return {
      provider: this.provider,
      model,
      text: response.output_text,
    };
  }
}

class AnthropicLlmClient implements LlmClient {
  provider = "anthropic" as const;

  async generateText(
    request: GenerateTextRequest,
  ): Promise<GenerateTextResult> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const model = resolveModel(this.provider, request.model);
    const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.prompt }],
    });

    const text = response.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");

    return {
      provider: this.provider,
      model,
      text,
    };
  }
}

class GoogleLlmClient implements LlmClient {
  provider = "google" as const;

  async generateText(
    request: GenerateTextRequest,
  ): Promise<GenerateTextResult> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const model = resolveModel(this.provider, request.model);
    const client = new GoogleGenerativeAI(
      requireEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
    );
    const generativeModel = client.getGenerativeModel({ model });
    const response = await generativeModel.generateContent(combinePrompt(request));

    return {
      provider: this.provider,
      model,
      text: response.response.text(),
    };
  }
}

export function createLlmClient(provider?: LlmProvider): LlmClient {
  const selectedProvider =
    provider ?? getDefaultLlmSettings().provider ?? getEnv("DEFAULT_LLM_PROVIDER");

  if (selectedProvider === "anthropic") {
    return new AnthropicLlmClient();
  }

  if (selectedProvider === "google") {
    return new GoogleLlmClient();
  }

  return new OpenAiLlmClient();
}

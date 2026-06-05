import {
  getDefaultLlmSettings,
  getEnv,
  type LlmProvider,
  requireEnv,
} from "@/lib/env";
import { estimateLlmCost } from "./pricing";
import type {
  GenerateTextRequest,
  GenerateTextResult,
  LlmClient,
  LlmUsage,
} from "./types";

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

function cleanNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toJsonSafe(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

function makeUsage(input: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  raw?: unknown;
}): LlmUsage | undefined {
  const inputTokens = cleanNumber(input.inputTokens);
  const outputTokens = cleanNumber(input.outputTokens);
  const totalTokens =
    cleanNumber(input.totalTokens) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    raw: toJsonSafe(input.raw),
  };
}

function withCost(result: Omit<GenerateTextResult, "estimatedCostUsd">) {
  return {
    ...result,
    estimatedCostUsd: estimateLlmCost({
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    }),
  };
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

    const usage = makeUsage({
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      totalTokens: response.usage?.total_tokens,
      raw: response.usage,
    });

    return withCost({
      provider: this.provider,
      model,
      text: response.output_text,
      usage,
    });
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

    const usage = makeUsage({
      inputTokens:
        (response.usage.input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      raw: response.usage,
    });

    return withCost({
      provider: this.provider,
      model,
      text,
      usage,
    });
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

    const usageMetadata = response.response.usageMetadata;
    const usage = makeUsage({
      inputTokens: usageMetadata?.promptTokenCount,
      outputTokens: usageMetadata?.candidatesTokenCount,
      totalTokens: usageMetadata?.totalTokenCount,
      raw: usageMetadata,
    });

    return withCost({
      provider: this.provider,
      model,
      text: response.response.text(),
      usage,
    });
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

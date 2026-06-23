import type { LlmProvider } from "@/lib/env";
import type { LlmUsage } from "./types";

type ModelPrice = {
  provider: LlmProvider;
  model: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  longContextInputPerMillionUsd?: number;
  longContextOutputPerMillionUsd?: number;
  longContextThresholdTokens?: number;
};

export const LLM_PRICING_VERSION = "2026-06-23";

const MODEL_PRICES: ModelPrice[] = [
  {
    provider: "openai",
    model: "gpt-5.5",
    inputPerMillionUsd: 5,
    outputPerMillionUsd: 30,
    longContextInputPerMillionUsd: 10,
    longContextOutputPerMillionUsd: 45,
    longContextThresholdTokens: 272_000,
  },
  {
    provider: "openai",
    model: "gpt-5.4",
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 15,
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    inputPerMillionUsd: 0.75,
    outputPerMillionUsd: 4.5,
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    inputPerMillionUsd: 2,
    outputPerMillionUsd: 8,
  },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    inputPerMillionUsd: 0.4,
    outputPerMillionUsd: 1.6,
  },
  {
    provider: "openai",
    model: "gpt-4.1-nano",
    inputPerMillionUsd: 0.1,
    outputPerMillionUsd: 0.4,
  },
  {
    provider: "openai",
    model: "gpt-4o",
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPerMillionUsd: 0.15,
    outputPerMillionUsd: 0.6,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4.5",
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
  },
  {
    provider: "google",
    model: "gemini-2.5-pro",
    inputPerMillionUsd: 1.25,
    outputPerMillionUsd: 10,
    longContextInputPerMillionUsd: 2.5,
    longContextOutputPerMillionUsd: 15,
    longContextThresholdTokens: 200_000,
  },
];

function normalizeModel(model: string) {
  return model.trim().toLowerCase();
}

function getAnthropicFamilyPrice(model: string): ModelPrice | undefined {
  if (model.startsWith("claude-fable-5") || model.startsWith("claude-mythos-5")) {
    return {
      provider: "anthropic",
      model,
      inputPerMillionUsd: 10,
      outputPerMillionUsd: 50,
    };
  }

  if (model.startsWith("claude-opus-4-")) {
    return {
      provider: "anthropic",
      model,
      inputPerMillionUsd: 5,
      outputPerMillionUsd: 25,
    };
  }

  if (model.startsWith("claude-sonnet-4-")) {
    return {
      provider: "anthropic",
      model,
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
    };
  }

  if (model.startsWith("claude-haiku-4-")) {
    return {
      provider: "anthropic",
      model,
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 5,
    };
  }

  return undefined;
}

function getModelPrice(provider: LlmProvider, model: string) {
  const normalizedModel = normalizeModel(model);
  const exactPrice = MODEL_PRICES.find(
    (item) =>
      item.provider === provider && normalizeModel(item.model) === normalizedModel,
  );

  if (exactPrice) {
    return exactPrice;
  }

  if (provider === "anthropic") {
    return getAnthropicFamilyPrice(normalizedModel);
  }

  return undefined;
}

export function estimateLlmCost({
  provider,
  model,
  usage,
}: {
  provider: LlmProvider;
  model: string;
  usage?: LlmUsage;
}) {
  if (!usage) {
    return null;
  }

  const price = getModelPrice(provider, model);

  if (!price) {
    return null;
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const useLongContext =
    price.longContextThresholdTokens !== undefined &&
    inputTokens > price.longContextThresholdTokens;
  const inputRate = useLongContext
    ? price.longContextInputPerMillionUsd ?? price.inputPerMillionUsd
    : price.inputPerMillionUsd;
  const outputRate = useLongContext
    ? price.longContextOutputPerMillionUsd ?? price.outputPerMillionUsd
    : price.outputPerMillionUsd;

  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

export function getPricingMetadata({
  provider,
  model,
  usage,
  estimatedCostUsd,
}: {
  provider: LlmProvider;
  model: string;
  usage?: LlmUsage;
  estimatedCostUsd?: number | null;
}) {
  return {
    status:
      usage && estimatedCostUsd !== null && estimatedCostUsd !== undefined
        ? "estimated"
        : usage
          ? "usage_only"
          : "unavailable",
    provider,
    model,
    usage: usage ?? null,
    estimatedCostUsd: estimatedCostUsd ?? null,
    pricingVersion: LLM_PRICING_VERSION,
  };
}

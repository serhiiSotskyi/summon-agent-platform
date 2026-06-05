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

export const LLM_PRICING_VERSION = "2026-06-04";

const MODEL_PRICES: ModelPrice[] = [
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

  const price = MODEL_PRICES.find(
    (item) =>
      item.provider === provider && normalizeModel(item.model) === normalizeModel(model),
  );

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

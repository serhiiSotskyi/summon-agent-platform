import { getEnv, type LlmProvider, requireEnv } from "@/lib/env";

export type LlmModelOption = {
  id: string;
  label: string;
  provider: LlmProvider;
  source: "openai-models-api" | "anthropic-models-api" | "google-models-api";
};

type CacheEntry = {
  expiresAt: number;
  models: LlmModelOption[];
};

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const modelCache = new Map<LlmProvider, CacheEntry>();

function modelLabel(id: string) {
  return id
    .replace(/^models\//, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function uniqueModels(models: LlmModelOption[]) {
  const seen = new Set<string>();

  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }

    seen.add(model.id);
    return true;
  });
}

function sortModels(models: LlmModelOption[]) {
  return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

function anthropicModelRank(id: string) {
  const model = id.toLowerCase();

  if (model.startsWith("claude-haiku-4-5")) {
    return 0;
  }

  if (model.startsWith("claude-sonnet-4-6")) {
    return 1;
  }

  if (model.startsWith("claude-sonnet-4-5")) {
    return 2;
  }

  if (model.startsWith("claude-opus-4-")) {
    return 3;
  }

  if (model.startsWith("claude-fable-") || model.startsWith("claude-mythos-")) {
    return 4;
  }

  return 5;
}

function sortAnthropicModels(models: LlmModelOption[]) {
  return [...models].sort(
    (a, b) =>
      anthropicModelRank(a.id) - anthropicModelRank(b.id) ||
      a.id.localeCompare(b.id),
  );
}

function isOpenAiAgentModel(id: string) {
  const model = id.toLowerCase();
  const excludedTerms = [
    "audio",
    "dall-e",
    "embedding",
    "image",
    "moderation",
    "realtime",
    "search",
    "speech",
    "transcribe",
    "tts",
    "whisper",
  ];

  if (excludedTerms.some((term) => model.includes(term))) {
    return false;
  }

  return (
    model.startsWith("gpt-") ||
    model.startsWith("chatgpt-") ||
    /^o\d/.test(model) ||
    model.startsWith("o-") ||
    model.startsWith("codex-")
  );
}

async function listOpenAiModels(): Promise<LlmModelOption[]> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  const response = await client.models.list();

  return sortModels(
    uniqueModels(
      response.data
        .map((model) => model.id)
        .filter(isOpenAiAgentModel)
        .map((id) => ({
          id,
          label: modelLabel(id),
          provider: "openai" as const,
          source: "openai-models-api" as const,
        })),
    ),
  );
}

async function listAnthropicModels(): Promise<LlmModelOption[]> {
  const response = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": requireEnv("ANTHROPIC_API_KEY"),
    },
  });

  if (!response.ok) {
    throw new Error(`Anthropic Models API returned ${response.status}.`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown; display_name?: unknown }>;
  };

  return sortAnthropicModels(
    uniqueModels(
      (payload.data ?? [])
        .map((model) => ({
          id: typeof model.id === "string" ? model.id : "",
          label:
            typeof model.display_name === "string" && model.display_name.trim()
              ? model.display_name
              : modelLabel(typeof model.id === "string" ? model.id : ""),
          provider: "anthropic" as const,
          source: "anthropic-models-api" as const,
        }))
        .filter((model) => model.id),
    ),
  );
}

async function listGoogleModels(): Promise<LlmModelOption[]> {
  const apiKey = requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      apiKey,
    )}`,
  );

  if (!response.ok) {
    throw new Error(`Google Models API returned ${response.status}.`);
  }

  const payload = (await response.json()) as {
    models?: Array<{
      displayName?: unknown;
      name?: unknown;
      supportedGenerationMethods?: unknown;
    }>;
  };

  return sortModels(
    uniqueModels(
      (payload.models ?? [])
        .filter((model) =>
          Array.isArray(model.supportedGenerationMethods)
            ? model.supportedGenerationMethods.includes("generateContent")
            : false,
        )
        .map((model) => {
          const name = typeof model.name === "string" ? model.name : "";
          const id = name.replace(/^models\//, "");

          return {
            id,
            label:
              typeof model.displayName === "string" && model.displayName.trim()
                ? model.displayName
                : modelLabel(id),
            provider: "google" as const,
            source: "google-models-api" as const,
          };
        })
        .filter((model) => model.id),
    ),
  );
}

export function hasModelListEnv(provider: LlmProvider) {
  if (provider === "openai") {
    return Boolean(getEnv("OPENAI_API_KEY"));
  }

  if (provider === "anthropic") {
    return Boolean(getEnv("ANTHROPIC_API_KEY"));
  }

  return Boolean(getEnv("GOOGLE_GENERATIVE_AI_API_KEY"));
}

export async function listProviderModels(provider: LlmProvider) {
  const cached = modelCache.get(provider);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  const models =
    provider === "openai"
      ? await listOpenAiModels()
      : provider === "anthropic"
        ? await listAnthropicModels()
        : await listGoogleModels();

  modelCache.set(provider, {
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    models,
  });

  return models;
}

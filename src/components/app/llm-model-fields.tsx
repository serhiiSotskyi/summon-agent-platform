"use client";

import { useEffect, useMemo, useState } from "react";
import { Label, Select } from "@/components/ui/form";

type LlmProvider = "openai" | "anthropic" | "google";

type ModelOption = {
  id: string;
  label: string;
  provider: LlmProvider;
  source: string;
};

type ModelResponse = {
  error?: string;
  message?: string;
  models?: ModelOption[];
  warning?: string | null;
};

const providerLabels: Record<LlmProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

function sourceLabel(source?: string | null) {
  if (source === "openai-models-api") {
    return "OpenAI Models API";
  }

  if (source === "anthropic-models-api") {
    return "Anthropic Models API";
  }

  if (source === "google-models-api") {
    return "Google Gemini Models API";
  }

  return "provider API";
}

function modelLabel(model: string) {
  return model
    .replace(/^models\//, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeProvider(provider: string): LlmProvider {
  return provider === "anthropic" || provider === "google" ? provider : "openai";
}

export function LlmModelFields({
  defaultModel,
  defaultProvider,
  workspaceId,
}: {
  defaultModel: string;
  defaultProvider: string;
  workspaceId: string;
}) {
  const [provider, setProvider] = useState<LlmProvider>(
    normalizeProvider(defaultProvider),
  );
  const [model, setModel] = useState(defaultModel);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const searchParams = new URLSearchParams({
      provider,
      workspace: workspaceId,
    });

    fetch(`/api/llm/models?${searchParams.toString()}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as ModelResponse;

        if (!response.ok) {
          throw new Error(payload.message ?? payload.error ?? "Model list failed.");
        }

        return payload;
      })
      .then((payload) => {
        const nextModels = payload.models ?? [];
        setModels(nextModels);
        setStatus("loaded");
        setMessage(
          payload.warning ??
            (nextModels[0]?.source
              ? `Loaded from ${sourceLabel(nextModels[0].source)}.`
              : ""),
        );

        setModel((currentModel) =>
          nextModels.length > 0 &&
          !nextModels.some((item) => item.id === currentModel)
            ? nextModels[0].id
            : currentModel,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setModels([]);
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Model list failed.");
      });

    return () => controller.abort();
  }, [provider, workspaceId]);

  const options = useMemo(() => {
    const officialOptions = models.map((item) => ({
      id: item.id,
      label: item.label || modelLabel(item.id),
    }));

    if (model && !officialOptions.some((item) => item.id === model)) {
      return [
        {
          id: model,
          label:
            status === "loaded" && officialOptions.length > 0
              ? `${modelLabel(model)} (current)`
              : modelLabel(model),
        },
        ...officialOptions,
      ];
    }

    return officialOptions;
  }, [model, models, status]);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="llmProvider">Provider</Label>
        <Select
          id="llmProvider"
          name="llmProvider"
          onChange={(event) => {
            setProvider(event.target.value as LlmProvider);
            setStatus("loading");
            setMessage("");
            setModels([]);
          }}
          value={provider}
        >
          {Object.entries(providerLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="llmModel">Model</Label>
        <Select
          id="llmModel"
          name="llmModel"
          onChange={(event) => setModel(event.target.value)}
          value={model}
        >
          {options.length > 0 ? (
            options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))
          ) : (
            <option value="">No models available</option>
          )}
        </Select>
        <p className="text-xs leading-5 text-zinc-500">
          {status === "loading" ? "Loading official model list..." : message}
        </p>
      </div>
    </>
  );
}

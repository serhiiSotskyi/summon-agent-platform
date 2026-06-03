import { getDefaultLlmSettings } from "@/lib/env";

export const RETENTION_MONTHS = 12;

export function getDefaultAgentConfig() {
  const llm = getDefaultLlmSettings();

  return {
    llmProvider: llm.provider,
    llmModel: llm.model,
    actionPermissionMode: "ASK_BEFORE_CHANGES",
    deliveryPermissionMode: "ASK_BEFORE_SENDING",
  } as const;
}

export function getRetainedUntil(from = new Date()) {
  const retainedUntil = new Date(from);
  retainedUntil.setMonth(retainedUntil.getMonth() + RETENTION_MONTHS);
  return retainedUntil;
}

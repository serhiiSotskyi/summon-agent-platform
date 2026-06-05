import { getDefaultLlmSettings } from "@/lib/env";

export const RETENTION_MONTHS = 12;

export const SUMMON_MEMORY_SYSTEM_INSTRUCTION = [
  "Use Summon's Notion and Google Drive memory as the primary source for company context, budget trackers, reporting files, channel notes, and client-specific operating knowledge.",
  "Before answering, look for relevant connector evidence from Notion and Google Drive when those tools are connected.",
  "Treat direct Google Ads and GA4 API access as optional unless those connectors are active; budget and performance data may live in Drive spreadsheets or Notion notes instead.",
  "Cite the connector evidence used, identify missing sources clearly, and do not invent live account access.",
].join(" ");

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

import { getDefaultLlmSettings } from "@/lib/env";

export const RETENTION_MONTHS = 12;

export const SUMMON_MEMORY_SYSTEM_INSTRUCTION = [
  "Use Summon's Notion and Google Drive memory as the primary source for company context, budget trackers, reporting files, channel notes, PPC/Google Ads spreadsheet data, and client-specific operating knowledge.",
  "Always search the supplied Notion and Google Drive evidence first, especially sources matching Summon Memory, budget trackers, reporting templates, PPC budget, Google Ads, client docs, or shared Drive spreadsheets.",
  "Treat direct Google Ads and GA4 API access as optional secondary sources unless those connectors are active; budget and performance data may live in Drive spreadsheets or Notion notes instead.",
  "Cite evidence by source title and URL when available. If the connector evidence does not verify a claim, say not found or unverified instead of inventing live account access.",
  "Separate verified findings from recommendations, and call out any protected business-impacting change that needs approval before execution.",
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

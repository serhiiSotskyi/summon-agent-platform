import type { ActionPermissionMode, DeliveryPermissionMode } from "@prisma/client";
import type { LlmProvider } from "@/lib/env";
import {
  DEFAULT_AGENT_TOOL_KEYS,
  normalizeExplicitAgentToolSelection,
} from "@/lib/tools/definitions";

export type AutomationCostProfile =
  | "cheap"
  | "best_value"
  | "high_quality"
  | "premium";

export type AutomationPolicyReference = {
  content_text?: string;
  description?: string;
  mime_type?: string;
  name?: string;
  role?: string;
  source_type?: string;
  url?: string;
};

export type AutomationPolicyInput = {
  actionPermissionMode?: ActionPermissionMode;
  audience?: string;
  costProfile?: AutomationCostProfile;
  defaultModel: string;
  deliveryPermissionMode?: DeliveryPermissionMode;
  desiredOutcome?: string;
  llmProvider: LlmProvider;
  premiumModelApproved?: boolean;
  references?: AutomationPolicyReference[];
  requestedModel?: string;
  requestedTools?: string[];
  sharingNotes?: string;
  successCriteria?: string;
  taskBrief: string;
};

export type AutomationPolicy = {
  actionPermissionMode: ActionPermissionMode;
  costProfile: AutomationCostProfile;
  deliveryPermissionMode: DeliveryPermissionMode;
  ignoredRequestedTools: string[];
  llmModel: string;
  llmProvider: LlmProvider;
  reasons: string[];
  requiredConnectors: string[];
  tools: string[];
  warnings: string[];
};

const OPENAI_MODEL_BY_COST_PROFILE = {
  cheap: "gpt-4.1-mini",
  best_value: "gpt-4.1",
  high_quality: "gpt-4.1",
  premium: "gpt-5.5",
} satisfies Record<AutomationCostProfile, string>;

const BROAD_TOOL_REQUEST_THRESHOLD = 8;

function textIncludes(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function addReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function addTool(tools: Set<string>, reasons: string[], tool: string, reason: string) {
  tools.add(tool);
  addReason(reasons, reason);
}

function policyText(input: AutomationPolicyInput) {
  return [
    input.taskBrief,
    input.desiredOutcome,
    input.successCriteria,
    input.sharingNotes,
    input.audience,
    ...(input.references ?? []).flatMap((reference) => [
      reference.name,
      reference.description,
      reference.role,
      reference.url,
      reference.mime_type,
      reference.content_text?.slice(0, 2000),
    ]),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function isPremiumModel(model: string) {
  const normalized = model.toLowerCase();
  return (
    normalized.includes("gpt-5") ||
    normalized.includes("gpt-5.5") ||
    normalized.includes("opus")
  );
}

function chooseModel(input: AutomationPolicyInput, warnings: string[]) {
  const profile = input.costProfile ?? "best_value";
  const profileModel =
    input.llmProvider === "openai"
      ? OPENAI_MODEL_BY_COST_PROFILE[profile]
      : input.defaultModel;
  const requested = input.requestedModel?.trim();

  if (!requested) {
    return profileModel || input.defaultModel;
  }

  if (isPremiumModel(requested) && !(profile === "premium" && input.premiumModelApproved)) {
    warnings.push(
      `Requested premium model ${requested} was replaced with ${profileModel} because premium recurring models require explicit approval.`,
    );
    return profileModel || input.defaultModel;
  }

  if (profile === "cheap" && requested !== profileModel) {
    warnings.push(
      `Requested model ${requested} was replaced with ${profileModel} because cost_profile is cheap.`,
    );
    return profileModel || input.defaultModel;
  }

  return requested;
}

function urlLooksLikeSheet(reference: AutomationPolicyReference) {
  return /docs\.google\.com\/spreadsheets/i.test(reference.url ?? "");
}

function urlLooksLikeDoc(reference: AutomationPolicyReference) {
  return /docs\.google\.com\/document/i.test(reference.url ?? "");
}

function urlLooksLikeSlides(reference: AutomationPolicyReference) {
  return /docs\.google\.com\/presentation/i.test(reference.url ?? "");
}

function requestedToolsToKeep(
  input: AutomationPolicyInput,
  warnings: string[],
  isCompatible: (tool: string) => boolean,
) {
  const requested = (input.requestedTools ?? []).filter(Boolean);
  if (requested.length === 0) {
    return [];
  }

  const uniqueRequested = Array.from(new Set(requested));
  const isBroadDefaultRequest =
    uniqueRequested.length >= BROAD_TOOL_REQUEST_THRESHOLD ||
    DEFAULT_AGENT_TOOL_KEYS.every((tool) => uniqueRequested.includes(tool));

  if (isBroadDefaultRequest) {
    warnings.push(
      "Ignored an overbroad requested tool set from Claude and inferred a smaller set from the task brief.",
    );
    return [];
  }

  const compatible = uniqueRequested.filter(isCompatible);
  const ignored = uniqueRequested.filter((tool) => !isCompatible(tool));

  if (ignored.length > 0) {
    warnings.push(
      `Ignored requested tools that do not match the task brief: ${ignored.join(", ")}.`,
    );
  }

  return compatible;
}

export function inferAutomationPolicy(input: AutomationPolicyInput): AutomationPolicy {
  const text = policyText(input);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const tools = new Set<string>();
  const references = input.references ?? [];

  const hasSheetReference = references.some(urlLooksLikeSheet);
  const hasDocReference = references.some(urlLooksLikeDoc);
  const hasSlidesReference = references.some(urlLooksLikeSlides);
  const mentionsSheets =
    hasSheetReference ||
    textIncludes(text, [
      /\bspreadsheet\b/,
      /\bgoogle sheet\b/,
      /\bsheet\b/,
      /\bcsv\b/,
      /\btracker\b/,
      /\bbudget\b/,
      /\bpacing\b/,
    ]);
  const needsComputation = textIncludes(text, [
    /\banaly[sz]e\b/,
    /\bcalculate\b/,
    /\bcompute\b/,
    /\bvalidation\b/,
    /\bvalidate\b/,
    /\btransform\b/,
    /\bnormalize\b/,
    /\bpacing\b/,
    /\bbudget\b/,
    /\bforecast\b/,
    /\bflag\b/,
    /\bcompare\b/,
  ]);
  const wantsNotion = textIncludes(text, [
    /\bnotion\b/,
    /\bmemory\b/,
    /\bshared result/,
    /\bteam can see\b/,
    /\bpublish\b/,
    /\bwrite results\b/,
    /\bsave results\b/,
    /\bautomated result/,
  ]);
  const wantsDocs =
    hasDocReference ||
    textIncludes(text, [
      /\bgoogle doc\b/,
      /\bdocument\b/,
      /\bmemo\b/,
      /\bbrief\b/,
      /\bwrite[- ]?up\b/,
    ]);
  const wantsSlides =
    hasSlidesReference ||
    textIncludes(text, [
      /\bslides?\b/,
      /\bpresentation\b/,
      /\bdeck\b/,
      /\bqbr\b/,
      /\breport deck\b/,
    ]);
  const wantsWeb = textIncludes(text, [
    /\bweb\b/,
    /\bsearch\b/,
    /\bresearch\b/,
    /\blatest\b/,
    /\bnews\b/,
    /\bcompetitor\b/,
    /\bmarket\b/,
    /\bpublic source\b/,
  ]);
  const wantsLiveAds = textIncludes(text, [
    /\bgoogle ads\b/,
    /\badwords\b/,
    /\bcampaign performance\b/,
    /\blive account\b/,
    /\bkeyword\b/,
    /\bsearch terms?\b/,
  ]);
  const wantsAnalytics = textIncludes(text, [
    /\bga4\b/,
    /\bgoogle analytics\b/,
    /\banalytics\b/,
    /\bconversion\b/,
    /\bsessions?\b/,
    /\btraffic\b/,
  ]);
  const wantsDriveOutput = textIncludes(text, [
    /\bgoogle drive\b/,
    /\bdrive file\b/,
    /\bmarkdown file\b/,
    /\btext file\b/,
    /\bexport\b/,
  ]);

  if (mentionsSheets) {
    addTool(
      tools,
      reasons,
      "google.sheets.readRange",
      hasSheetReference
        ? "Google Sheets reference detected."
        : "Spreadsheet or tracker data detected.",
    );
  }

  if (needsComputation) {
    addTool(
      tools,
      reasons,
      "python.run",
      "Task requires calculations, validation, transformation, or data analysis.",
    );
  }

  if (wantsNotion || tools.size > 0) {
    addTool(
      tools,
      reasons,
      "notion.createPage",
      wantsNotion
        ? "Task asks to publish or share results in Notion/team memory."
        : "Automation needs a durable shared result page.",
    );
  }

  if (wantsDocs) {
    addTool(tools, reasons, "google.docs.readText", "Google Docs/document context detected.");
    addTool(tools, reasons, "google.docs.createDocument", "Document output may be needed.");
  }

  if (wantsSlides) {
    addTool(tools, reasons, "google.slides.copyTemplate", "Slides/deck output detected.");
    addTool(tools, reasons, "google.slides.inspectTemplate", "Slides work needs template inspection.");
    addTool(tools, reasons, "google.slides.batchUpdate", "Slides work needs run-owned deck updates.");
  }

  if (wantsWeb) {
    addTool(tools, reasons, "web.search", "Public web research/current context detected.");
    addTool(tools, reasons, "web.readPage", "Web research may need reading cited pages.");
  }

  if (wantsLiveAds && !hasSheetReference) {
    addTool(tools, reasons, "google-ads", "Live Google Ads reporting requested.");
  }

  if (wantsAnalytics) {
    addTool(tools, reasons, "ga4", "Google Analytics/GA4 reporting requested.");
  }

  if (wantsDriveOutput) {
    addTool(tools, reasons, "google.drive.createTextFile", "Google Drive file output detected.");
  }

  const inferredTools = new Set(tools);
  const requestedToolMatchesBrief = (tool: string) => {
    if (inferredTools.has(tool)) {
      return true;
    }

    if (tool === "google-drive") {
      return (
        mentionsSheets ||
        wantsDocs ||
        wantsSlides ||
        wantsDriveOutput ||
        Array.from(inferredTools).some((candidate) => candidate.startsWith("google."))
      );
    }

    if (tool === "notion") {
      return inferredTools.has("notion.createPage") || wantsNotion;
    }

    if (tool === "python.run") {
      return needsComputation;
    }

    if (tool === "web.search" || tool === "web.readPage") {
      return wantsWeb;
    }

    if (tool === "google-ads") {
      return wantsLiveAds && !hasSheetReference;
    }

    if (tool === "ga4") {
      return wantsAnalytics;
    }

    if (tool.startsWith("google.sheets.")) {
      return mentionsSheets;
    }

    if (tool.startsWith("google.docs.")) {
      return wantsDocs;
    }

    if (tool.startsWith("google.slides.")) {
      return wantsSlides;
    }

    if (tool.startsWith("google.drive.")) {
      return wantsDriveOutput || wantsDocs || wantsSlides;
    }

    return false;
  };

  for (const tool of requestedToolsToKeep(input, warnings, requestedToolMatchesBrief)) {
    tools.add(tool);
    addReason(reasons, `Claude requested tool ${tool}; included as a narrow explicit request.`);
  }

  if (tools.size === 0) {
    tools.add("notion");
    tools.add("notion.createPage");
    addReason(
      reasons,
      "No specific source connector was detected, so the automation starts with Notion memory output only.",
    );
  }

  const normalizedTools = normalizeExplicitAgentToolSelection(Array.from(tools));
  const requiredConnectors = normalizedTools.filter((tool) =>
    ["google-ads", "ga4", "notion", "google-drive"].includes(tool),
  );

  return {
    actionPermissionMode: input.actionPermissionMode ?? "ASK_BEFORE_CHANGES",
    costProfile: input.costProfile ?? "best_value",
    deliveryPermissionMode: input.deliveryPermissionMode ?? "ASK_BEFORE_SENDING",
    ignoredRequestedTools: (input.requestedTools ?? []).filter(
      (tool) => !normalizedTools.includes(tool),
    ),
    llmModel: chooseModel(input, warnings),
    llmProvider: input.llmProvider,
    reasons,
    requiredConnectors,
    tools: normalizedTools,
    warnings,
  };
}

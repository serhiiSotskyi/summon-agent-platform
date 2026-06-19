import { Prisma, type Agent, type AgentFile } from "@prisma/client";
import {
  batchUpdateGoogleDoc,
  batchUpdateGoogleSlides,
  copyGoogleDriveFile,
  createGoogleDoc,
  createGoogleDriveTextFile,
  createNotionPage,
  inspectGoogleSlidesTemplate,
  readGoogleDocText,
  readGoogleSlidesText,
  readGoogleSheetRange,
  replaceGoogleDocText,
  replaceGoogleSlidesText,
  updateGoogleSlidesTableCell,
  updateGoogleSlidesTextElement,
  updateGoogleSheetRange,
} from "@/lib/connectors/write";
import { getDb } from "@/lib/db";
import type { LlmProvider } from "@/lib/env";
import { createLlmClient } from "@/lib/llm";
import type { GenerateTextResult, LlmUsage } from "@/lib/llm/types";
import {
  GENERIC_AGENT_TOOLS,
  genericToolDefinition,
  isGenericAgentToolKey,
  type GenericAgentToolKey,
} from "@/lib/tools/definitions";
import { runPythonInSandbox } from "@/lib/tools/python-sandbox";

const MAX_TOOL_ITERATIONS = 12;
const MAX_TOOL_CALLS_PER_ITERATION = 5;
const TOOL_LLM_TIMEOUT_MS = 45_000;
const FINAL_LLM_TIMEOUT_MS = 45_000;

type ToolLoopAgent = Pick<
  Agent,
  "id" | "name" | "description" | "systemPrompt" | "tools" | "llmProvider" | "llmModel"
> & {
  files: Array<
    Pick<
      AgentFile,
      | "id"
      | "name"
      | "description"
      | "role"
      | "sourceType"
      | "url"
      | "originalFileName"
      | "mimeType"
      | "contentText"
      | "sizeBytes"
    >
  >;
};

type PlannedToolCall = {
  tool: string;
  input?: unknown;
  reason?: string;
};

type ToolLoopInput = {
  agentRunId: string;
  workspaceId: string;
  agent: ToolLoopAgent;
  provider: LlmProvider;
  model: string;
  basePrompt: string;
  systemPrompt: string;
  selectedTools: string[];
};

type RuntimeState = {
  createdGoogleFileIds: Set<string>;
  createdGoogleFiles: Array<{
    fileId: string;
    fileName: string;
    webViewLink: string | null;
    mimeType: string | null;
  }>;
  protectedActionRequests: string[];
};

type WorkflowRequirementState = {
  requiresSlidesDeckWrite: boolean;
  requiresGoogleDocWrite: boolean;
  requiresNotionPublish: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

async function withLocalTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function compactText(value: unknown, maxLength = 3000) {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}

function compactGeneratedFileForPrompt(value: unknown) {
  const file = asRecord(value);
  const payload = asRecord(file.payload);
  const name = asString(file.name, "artifact");
  const mimeType = asString(file.mimeType);
  const preview = asString(payload.contentPreview);
  const shouldKeepPreview =
    name.toLowerCase().endsWith(".json") ||
    name.toLowerCase().includes("metrics") ||
    mimeType.includes("json");

  return {
    id: file.id,
    type: file.type,
    name,
    location: file.location,
    mimeType: file.mimeType,
    status: file.status,
    payload: {
      ...payload,
      contentPreview: shouldKeepPreview && preview ? compactText(preview, 3000) : undefined,
    },
  };
}

function generatedArtifactJson(artifact: Record<string, unknown>) {
  const payload = asRecord(artifact.payload);
  const parsed = asRecord(payload.parsedJson);
  if (Object.keys(parsed).length > 0) {
    return parsed;
  }

  const preview = asString(payload.contentPreview);
  if (!preview) {
    return {};
  }

  try {
    return JSON.parse(preview) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function compactToolInputForPrompt(toolName: string, value: unknown) {
  const input = asRecord(value);

  if (toolName === "python.run") {
    return {
      entryFile: input.entryFile,
      args: input.args,
      code: asString(input.code) ? compactText(input.code, 1200) : undefined,
    };
  }

  if (toolName === "google.slides.batchUpdate") {
    return {
      presentationId: input.presentationId,
      requestCount: asObjectArray(input.requests).length,
    };
  }

  if (toolName === "google.docs.batchUpdate") {
    return {
      documentId: input.documentId,
      requestCount: asObjectArray(input.requests).length,
    };
  }

  if (toolName === "google.slides.auditDeck") {
    return {
      presentationId: input.presentationId,
      targetClient: input.targetClient,
      targetMarket: input.targetMarket,
      expectedCurrency: input.expectedCurrency,
      hasReportData: Object.keys(asRecord(input.reportData)).length > 0,
    };
  }

  if (toolName === "google.slides.inspectTemplate" || toolName === "google.slides.readText") {
    return { presentationId: input.presentationId };
  }

  if (toolName === "google.docs.readText") {
    return { documentId: input.documentId };
  }

  if (
    toolName === "notion.createPage" ||
    toolName === "google.drive.createTextFile" ||
    toolName === "google.docs.createDocument"
  ) {
    return {
      title: input.title,
      name: input.name,
      mimeType: input.mimeType,
      content: compactText(input.content, 1600),
      links: input.links,
    };
  }

  return input;
}

function compactToolResultForPrompt(value: unknown) {
  const record = asRecord(value);
  const toolName = asString(record.toolName);
  if (!toolName) {
    return value;
  }

  const result = asRecord(record.result);
  const base = {
    id: record.id,
    toolName,
    status: record.status,
    input: compactToolInputForPrompt(toolName, record.input),
    error: record.error,
    artifacts: asObjectArray(record.artifacts).map(compactGeneratedFileForPrompt),
  };

  if (toolName === "python.run") {
    return {
      ...base,
      result: {
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: compactText(result.stdout, 2000),
        stderr: compactText(result.stderr, 2000),
        files: asObjectArray(result.files).map(compactGeneratedFileForPrompt),
      },
    };
  }

  if (toolName === "google.slides.replaceText") {
    return {
      ...base,
      result: {
        presentationId: result.presentationId,
        replacementResults: result.replacementResults,
      },
    };
  }

  if (toolName === "google.docs.replaceText") {
    return {
      ...base,
      result: {
        documentId: result.documentId,
        replacementResults: result.replacementResults,
      },
    };
  }

  if (toolName === "google.docs.readText") {
    return {
      ...base,
      result: {
        documentId: result.documentId,
        title: result.title,
        preview: compactText(result.preview, 2400),
      },
    };
  }

  if (toolName === "google.slides.readText") {
    return {
      ...base,
      result: {
        presentationId: result.presentationId,
        title: result.title,
        slides: asObjectArray(result.slides)
          .slice(0, 16)
          .map((slide) => ({
            slideIndex: slide.slideIndex,
            slideObjectId: slide.slideObjectId,
            textElements: asObjectArray(slide.textElements)
              .slice(0, 14)
              .map((element) => ({
                objectId: element.objectId,
                text: compactText(element.text, 360),
              })),
          })),
      },
    };
  }

  if (toolName === "google.slides.inspectTemplate") {
    return {
      ...base,
      result: {
        presentationId: result.presentationId,
        title: result.title,
        slides: asObjectArray(result.slides)
          .slice(0, 24)
          .map((slide) => ({
            slideIndex: slide.slideIndex,
            slideObjectId: slide.slideObjectId,
            classification: slide.classification,
            titleCandidate: compactText(slide.titleCandidate, 220),
            textElements: asObjectArray(slide.textElements)
              .slice(0, 18)
              .map((element) => ({
                objectId: element.objectId,
                source: element.source,
                rowIndex: element.rowIndex,
                columnIndex: element.columnIndex,
                text: compactText(element.text, 260),
              })),
            pageElements: asObjectArray(slide.pageElements)
              .slice(0, 18)
              .map((element) => ({
                objectId: element.objectId,
                type: element.type,
                shapeType: element.shapeType,
                text: compactText(element.text, 180),
                table: element.table
                  ? {
                      rowCount: asRecord(element.table).rowCount,
                      columnCount: asRecord(element.table).columnCount,
                    }
                  : null,
                hasImage: Boolean(element.image),
                hasChart: Boolean(element.sheetsChart),
              })),
          })),
      },
    };
  }

  if (toolName === "google.slides.auditDeck") {
    return {
      ...base,
      result: {
        presentationId: result.presentationId,
        passed: result.passed,
        score: result.score,
        staleReferences: asObjectArray(result.staleReferences).slice(0, 20),
        missingExpectedValues: asStringArray(result.missingExpectedValues).slice(0, 20),
        slideStatuses: asObjectArray(result.slideStatuses)
          .slice(0, 30)
          .map((slide) => ({
            slideIndex: slide.slideIndex,
            classification: slide.classification,
            status: slide.status,
            reasons: slide.reasons,
          })),
        recommendations: asStringArray(result.recommendations).slice(0, 10),
      },
    };
  }

  if (
    toolName === "google.slides.copyTemplate" ||
    toolName === "google.drive.copyFile" ||
    toolName === "google.drive.createTextFile" ||
    toolName === "google.docs.createDocument"
  ) {
    return {
      ...base,
      result: {
        fileId: result.fileId,
        documentId: result.documentId,
        presentationId: result.presentationId,
        fileName: result.fileName,
        webViewLink: result.webViewLink,
        mimeType: result.mimeType,
      },
    };
  }

  if (toolName === "notion.createPage") {
    return {
      ...base,
      result: {
        pageId: result.pageId,
        pageUrl: result.pageUrl,
      },
    };
  }

  return {
    ...base,
    result,
  };
}

function compactToolResultsForPrompt(results: unknown[]) {
  return results.map(compactToolResultForPrompt);
}

function compactBasePromptForPlanner(basePrompt: string) {
  const [beforeConnectorEvidence] = basePrompt.split("\nConnector evidence:");
  const [beforeFiles] = beforeConnectorEvidence.split(
    "\nAgent input files and references:",
  );

  return [
    compactText(beforeFiles, 6000),
    "",
    "Agent files are listed separately below without large content previews.",
    "Connector evidence is available for the final answer; use tools and prior tool results for execution planning.",
  ].join("\n");
}

function successfulToolResults(results: unknown[]) {
  return results
    .filter(isToolCallOutputRecord)
    .filter((result) => result.status === "succeeded");
}

function inferWorkflowRequirements(input: {
  agent: ToolLoopAgent;
  basePrompt: string;
  availableTools: GenericAgentToolKey[];
}): WorkflowRequirementState {
  const prompt = [
    input.agent.name,
    input.agent.description,
    input.agent.systemPrompt,
    input.basePrompt,
    ...input.agent.files.map((file) =>
      [file.name, file.description, file.role, file.url].filter(Boolean).join(" "),
    ),
  ]
    .join("\n")
    .toLowerCase();

  const hasSlidesTools =
    input.availableTools.includes("google.slides.copyTemplate") &&
    (input.availableTools.includes("google.slides.replaceText") ||
      input.availableTools.includes("google.slides.batchUpdate"));
  const mentionsSlidesOutput =
    /\b(deck|slide|slides|presentation|google slides|qbr|report)\b/.test(prompt);
  const asksToCreateOrPopulate =
    /\b(create|generate|recreate|populate|update|edit|replace|build|produce)\b/.test(prompt);

  const hasNotionTool = input.availableTools.includes("notion.createPage");
  const asksForNotionPublish =
    /\b(notion|memory page|summon memory|publish|create page|add .*memory)\b/.test(prompt) &&
    /\b(create|publish|add|write|summarize|link)\b/.test(prompt);
  const hasGoogleDocsTools =
    input.availableTools.includes("google.docs.createDocument") &&
    (input.availableTools.includes("google.docs.batchUpdate") ||
      input.availableTools.includes("google.docs.replaceText"));
  const mentionsGoogleDocOutput =
    /\b(google doc|google docs|doc|document|memo|brief|write-up|writeup|report)\b/.test(
      prompt,
    );

  return {
    requiresSlidesDeckWrite: hasSlidesTools && mentionsSlidesOutput && asksToCreateOrPopulate,
    requiresGoogleDocWrite:
      hasGoogleDocsTools && mentionsGoogleDocOutput && asksToCreateOrPopulate,
    requiresNotionPublish: hasNotionTool && asksForNotionPublish,
  };
}

function hasSuccessfulTool(results: unknown[], toolName: GenericAgentToolKey) {
  return successfulToolResults(results).some((result) => result.toolName === toolName);
}

function hasMeaningfulSlidesWrite(results: unknown[]) {
  return successfulToolResults(results).some((result) => {
    if (result.toolName === "google.slides.batchUpdate") {
      return true;
    }

    if (result.toolName !== "google.slides.replaceText") {
      return false;
    }

    const replacementResults = asObjectArray(asRecord(result.result).replacementResults);
    return replacementResults.some((replacement) => {
      const changed = replacement.occurrencesChanged;
      return typeof changed === "number" && changed > 0;
    });
  });
}

function hasRunOwnedGoogleDoc(results: unknown[]) {
  return successfulToolResults(results).some((result) => {
    if (result.toolName === "google.docs.createDocument") {
      return true;
    }

    if (result.toolName !== "google.drive.copyFile") {
      return false;
    }

    const mimeType = asString(asRecord(result.result).mimeType);
    return mimeType === "application/vnd.google-apps.document";
  });
}

function hasMeaningfulGoogleDocWrite(results: unknown[]) {
  return successfulToolResults(results).some((result) => {
    if (result.toolName === "google.docs.batchUpdate") {
      return true;
    }

    if (result.toolName !== "google.docs.replaceText") {
      return false;
    }

    const replacementResults = asObjectArray(asRecord(result.result).replacementResults);
    return replacementResults.some((replacement) => {
      const changed = replacement.occurrencesChanged;
      return typeof changed === "number" && changed > 0;
    });
  });
}

function hasDeckAudit(results: unknown[]) {
  return hasSuccessfulTool(results, "google.slides.auditDeck");
}

function hasPassingDeckAudit(results: unknown[]) {
  const audit = latestSuccessfulToolResult(results, "google.slides.auditDeck");
  return asRecord(audit?.result).passed === true;
}

function hasFailedDeckAudit(results: unknown[]) {
  const audit = latestSuccessfulToolResult(results, "google.slides.auditDeck");
  return Boolean(audit) && asRecord(audit?.result).passed === false;
}

function successfulToolCount(results: unknown[], toolName: GenericAgentToolKey) {
  return successfulToolResults(results).filter((result) => result.toolName === toolName)
    .length;
}

function latestSuccessfulToolName(results: unknown[]) {
  return asString(successfulToolResults(results).at(-1)?.toolName);
}

function missingWorkflowOutcomes(input: {
  requirements: WorkflowRequirementState;
  toolResults: unknown[];
  availableTools: GenericAgentToolKey[];
}) {
  const missing: string[] = [];

  if (input.requirements.requiresSlidesDeckWrite) {
    if (!hasSuccessfulTool(input.toolResults, "google.slides.copyTemplate")) {
      missing.push(
        "Copy the source/template deck into a run-owned Google Slides deck with google.slides.copyTemplate.",
      );
    } else if (
      input.availableTools.includes("google.slides.inspectTemplate") &&
      !hasSuccessfulTool(input.toolResults, "google.slides.inspectTemplate")
    ) {
      missing.push(
        "Inspect the copied Google Slides deck with google.slides.inspectTemplate before targeting slide/object/table edits.",
      );
    } else if (!hasMeaningfulSlidesWrite(input.toolResults)) {
      missing.push(
        "Populate the copied Google Slides deck with object/table/batch updates. Do not stop after copying or reading the deck.",
      );
    } else if (
      input.availableTools.includes("google.slides.auditDeck") &&
      !hasDeckAudit(input.toolResults)
    ) {
      missing.push(
        "Audit the generated deck with google.slides.auditDeck and address stale template content before finalizing.",
      );
    } else if (
      input.availableTools.includes("google.slides.auditDeck") &&
      hasDeckAudit(input.toolResults) &&
      !hasPassingDeckAudit(input.toolResults)
    ) {
      missing.push(
        "The latest generated deck audit failed. Fix stale template content, missing KPI values, or placeholder decisions and rerun the audit.",
      );
    }
  }

  if (input.requirements.requiresGoogleDocWrite) {
    if (!hasRunOwnedGoogleDoc(input.toolResults)) {
      missing.push(
        "Create or copy a run-owned Google Doc with google.docs.createDocument or google.drive.copyFile before writing document output.",
      );
    } else if (!hasMeaningfulGoogleDocWrite(input.toolResults)) {
      missing.push(
        "Write the required Google Doc output with google.docs.batchUpdate or google.docs.replaceText. Do not stop after creating an empty document.",
      );
    } else if (
      input.availableTools.includes("google.docs.readText") &&
      !hasSuccessfulTool(input.toolResults, "google.docs.readText")
    ) {
      missing.push(
        "Read back the generated Google Doc with google.docs.readText to verify the output before finalizing.",
      );
    }
  }

  if (
    input.requirements.requiresNotionPublish &&
    !hasSuccessfulTool(input.toolResults, "notion.createPage")
  ) {
    missing.push(
      "Create the required Notion memory page with notion.createPage and include the generated artifact links.",
    );
  }

  return missing;
}

function latestSuccessfulToolResult(results: unknown[], toolName: GenericAgentToolKey) {
  return successfulToolResults(results)
    .filter((result) => result.toolName === toolName)
    .at(-1);
}

function copiedPresentationId(results: unknown[]) {
  const copied = latestSuccessfulToolResult(results, "google.slides.copyTemplate");
  const result = asRecord(copied?.result);
  return asString(result.presentationId, asString(result.fileId));
}

function copiedPresentationLink(results: unknown[]) {
  const copied = latestSuccessfulToolResult(results, "google.slides.copyTemplate");
  const result = asRecord(copied?.result);
  return asString(result.webViewLink);
}

function metricArtifactJson(results: unknown[]) {
  const parsedCandidates: Array<{ name: string; data: Record<string, unknown> }> = [];
  for (const result of successfulToolResults(results)) {
    const candidates = [
      ...asObjectArray(result.artifacts),
      ...asObjectArray(asRecord(result.result).files),
    ];

    for (const artifact of candidates) {
      const name = asString(artifact.name).toLowerCase();
      if (
        !name.endsWith(".json") ||
        (!name.includes("metrics") && !name.includes("report_data"))
      ) {
        continue;
      }

      const data = generatedArtifactJson(artifact);
      if (Object.keys(data).length === 0) {
        continue;
      }
      parsedCandidates.push({ name, data });
    }
  }

  return (
    parsedCandidates.find((candidate) => candidate.name.includes("report_data"))?.data ??
    parsedCandidates.find((candidate) => candidate.name.includes("metrics"))?.data ??
    {}
  );
}

function normalizedDeckText(deckMap: Record<string, unknown>) {
  return asObjectArray(deckMap.slides)
    .flatMap((slide) =>
      asObjectArray(slide.textElements).map((element) => asString(element.text)),
    )
    .join("\n");
}

function reportMetadataFromArtifact(reportData: Record<string, unknown>) {
  const metadata = asRecord(reportData.metadata);
  return {
    client:
      asString(metadata.client) ||
      asString(reportData.client) ||
      asString(metadata.account) ||
      asString(reportData.account),
    market:
      asString(metadata.market) ||
      asString(reportData.market) ||
      asString(metadata.region) ||
      asString(reportData.region),
    period:
      asString(metadata.period) ||
      asString(reportData.period) ||
      asString(metadata.reportPeriod),
    currency:
      asString(metadata.currency) ||
      asString(reportData.currency) ||
      asString(metadata.currencyCode),
  };
}

function expectedReportValues(reportData: Record<string, unknown>) {
  return Array.from(new Set(genericReportMetricValues(reportData, false)));
}

function reportOverallKpis(reportData: Record<string, unknown>) {
  const overallKpis = asRecord(reportData.overall_kpis);
  return Object.keys(overallKpis).length > 0 ? overallKpis : asRecord(reportData.overall);
}

function currencyPrefix(currency: string) {
  const normalized = currency.toLowerCase();
  if (normalized === "aud") {
    return "A$";
  }
  if (normalized === "usd") {
    return "$";
  }
  if (normalized === "eur") {
    return "€";
  }
  if (normalized === "gbp" || currency === "£") {
    return "£";
  }
  return currency ? `${currency} ` : "";
}

function formatReportCurrency(value: unknown, currency: string, compact = false) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }

  const prefix = currencyPrefix(currency);
  if (compact) {
    return `${prefix}${Math.round(number / 1000).toLocaleString("en-GB")}K`;
  }

  return `${prefix}${Math.round(number).toLocaleString("en-GB")}`;
}

function formatReportDecimalCurrency(value: unknown, currency: string) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? `${currencyPrefix(currency)}${number.toFixed(2)}` : "";
}

function genericReportMetricValues(reportData: Record<string, unknown>, compactCost = false) {
  const metadata = reportMetadataFromArtifact(reportData);
  const currency = metadata.currency || "GBP";
  const overall = reportOverallKpis(reportData);
  return [
    formatIntegerMetric(overall.sales_leads ?? overall.leads),
    formatReportCurrency(overall.cost ?? overall.spend, currency, compactCost),
    formatReportDecimalCurrency(overall.cpl, currency),
    formatPercentMetric(overall.cvr),
    formatIntegerMetric(overall.clicks),
    formatPercentMetric(overall.ctr),
  ].filter(Boolean);
}

function latestDeckMap(results: unknown[]) {
  const inspected = latestSuccessfulToolResult(results, "google.slides.inspectTemplate");
  return asRecord(inspected?.result);
}

function genericReplaceSlideTextRequest(slideObjectId: string, find: string, replace: string) {
  return {
    replaceAllText: {
      containsText: {
        text: find,
        matchCase: true,
      },
      replaceText: replace,
      pageObjectIds: [slideObjectId],
    },
  };
}

function pushGenericSlideReplacement(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  slideObjectId: string,
  find: string,
  replace: string,
) {
  const trimmedFind = find.trim();
  const trimmedReplace = replace.trim();
  if (!trimmedFind || !trimmedReplace || trimmedFind === trimmedReplace) {
    return;
  }
  const key = `${slideObjectId}\u0000${trimmedFind}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  requests.push(genericReplaceSlideTextRequest(slideObjectId, trimmedFind, trimmedReplace));
}

function staleTermRegex(term: string) {
  const normalized = term.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "uk") {
    // Match the UK market label, but do not treat URL/domain fragments like .co.uk as stale copy.
    return /(?<![.\w-])uk(?![.\w-])/i;
  }

  if (normalized === "au") {
    return /(?<![.\w-])au(?![.\w-])/i;
  }

  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "i");
}

function staleTermMatch(text: string, term: string) {
  const regex = staleTermRegex(term);
  if (!regex) {
    return null;
  }

  return regex.exec(text);
}

function staleTermMatches(text: string, term: string) {
  return Boolean(staleTermMatch(text, term));
}

function isLikelyMetricText(value: string) {
  return /^(?:[A-Z]{0,3}\$|£|\$|€)?\s?[\d,.]+(?:K|M)?%?$/i.test(value.trim());
}

function reportDeckCommentary(reportData: Record<string, unknown>) {
  const metadata = reportMetadataFromArtifact(reportData);
  const overall = reportOverallKpis(reportData);
  const currency = metadata.currency || "GBP";
  const client = metadata.client || "the client";
  const market = metadata.market ? `${metadata.market} ` : "";
  const period = metadata.period ? ` for ${metadata.period}` : "";
  const leads = formatIntegerMetric(overall.sales_leads ?? overall.leads) || "unverified";
  const spend = formatReportCurrency(overall.cost ?? overall.spend, currency) || "unverified";
  const cpl = formatReportDecimalCurrency(overall.cpl, currency) || "unverified";
  const cvr = formatPercentMetric(overall.cvr) || "unverified";
  const clicks = formatIntegerMetric(overall.clicks) || "unverified";
  const ctr = formatPercentMetric(overall.ctr) || "unverified";

  return [
    `${client} ${market}performance${period} was rebuilt from the uploaded report data, not copied from the visual template.`,
    `The data shows ${leads} leads from ${spend} spend, with ${clicks} clicks, ${ctr} CTR, ${cpl} CPL, and ${cvr} CVR.`,
    "Slides with missing comparator, planning, auction, or update data should remain as human-editable placeholders until supporting evidence is attached.",
  ].join("\n");
}

function reportMissingSections(reportData: Record<string, unknown>) {
  return [
    ...asStringArray(reportData.missing_data_sections),
    ...asStringArray(reportData.recommended_placeholder_slides),
  ];
}

function placeholderReason(reportData: Record<string, unknown>, slideText: string) {
  const lowerSlideText = slideText.toLowerCase();
  const missing = reportMissingSections(reportData);
  const matching = missing.filter((section) => {
    const lower = section.toLowerCase();
    return lower
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5)
      .some((token) => lowerSlideText.includes(token));
  });

  return matching.slice(0, 2).join(" ") || missing.slice(0, 2).join(" ");
}

function shouldPlaceholderReportSlide(reportData: Record<string, unknown>, slideText: string) {
  const missingText = reportMissingSections(reportData).join(" ").toLowerCase();
  const lowerSlideText = slideText.toLowerCase();
  const rules = [
    {
      missing: ["auction"],
      slide: ["auction insight", "impression share", "outranking", "overlap rate"],
    },
    {
      missing: ["trend", "yoy", "prior-year", "prior year"],
      slide: ["google trends", "demand trend", "source: google trends"],
    },
    {
      missing: ["plans", "next steps", "client updates", "human-provided context"],
      slide: [
        "next steps",
        "other updates",
        "testing",
        "ad copy test",
        "gtm audit",
        "ai max",
        "ad monitor",
        "landing page test",
        "price inclusion",
        "live price",
      ],
    },
  ];

  return rules.some(
    (rule) =>
      rule.missing.some((term) => missingText.includes(term)) &&
      rule.slide.some((term) => lowerSlideText.includes(term)),
  );
}

function placeholderTextForSlide(reportData: Record<string, unknown>, slideText: string) {
  const reason = placeholderReason(reportData, slideText);
  return [
    "Placeholder - supporting data was not provided for this run.",
    reason ? `Reason: ${reason}` : "",
    "Attach the relevant export, memory note, or planning input and rerun the agent to populate this slide.",
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldPreservePlaceholderElement(text: string, slideTitle: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === slideTitle.trim().toLowerCase()) {
    return true;
  }
  if (/^q[1-4]\s+\d{4}/i.test(text)) {
    return true;
  }
  if (/summon digital|confidential|prepared by summon|wendy wu tours \|/i.test(text)) {
    return true;
  }
  return false;
}

function genericReportDeckBatchRequests(results: unknown[]) {
  const reportData = metricArtifactJson(results);
  const metadata = reportMetadataFromArtifact(reportData);
  const deckMap = latestDeckMap(results);
  const slides = asObjectArray(deckMap.slides);
  if (Object.keys(reportData).length === 0 || slides.length === 0) {
    return [];
  }

  const placeholderRequests: Record<string, unknown>[] = [];
  const updateRequests: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const client = metadata.client || "";
  const market = metadata.market || "";
  const targetLabel = [client, market].filter(Boolean).join(" ").trim();
  const values = genericReportMetricValues(reportData, true);
  const commentary = reportDeckCommentary(reportData);
  const staleTerms = staleTermsForTarget({
    targetMarket: market,
    targetClient: client,
    expectedCurrency: metadata.currency,
  });
  const nonCurrencyStaleTerms = staleTerms.filter((term) => !term.includes("£"));
  const currencyStaleTerms = staleTerms.filter((term) => term.includes("£"));

  for (const slide of slides) {
    const slideObjectId = asString(slide.slideObjectId);
    if (!slideObjectId) {
      continue;
    }

    const textElements = asObjectArray(slide.textElements);
    const slideText = textElements.map((element) => asString(element.text)).join(" ");
    const slideTitle = asString(slide.titleCandidate);
    const containsStaleTerm = staleTerms.some((term) => staleTermMatches(slideText, term));
    const containsExpectedValue = expectedReportValues(reportData).some((value) =>
      slideText.includes(value),
    );
    if (
      shouldPlaceholderReportSlide(reportData, slideText) ||
      (containsStaleTerm && !containsExpectedValue && !/summary|overview|performance report|qbr/i.test(slideText))
    ) {
      const placeholderText = placeholderTextForSlide(reportData, slideText);
      const placeholderElements = textElements
        .map((element) => asString(element.text))
        .filter((text) => !shouldPreservePlaceholderElement(text, slideTitle))
        .filter((text) => text.trim().length > 0 && text.trim() !== "—")
        .sort((a, b) => b.length - a.length);

      placeholderElements.slice(0, 80).forEach((text, index) => {
        pushGenericSlideReplacement(
          placeholderRequests,
          seen,
          slideObjectId,
          text,
          index === 0 ? placeholderText : "—",
        );
      });

      for (const term of staleTerms) {
        if (!staleTermMatches(slideText, term)) {
          continue;
        }
        const normalizedTerm = term.trim().toLowerCase();
        const replacement = normalizedTerm === "£" ? currencyPrefix(metadata.currency) : "—";
        pushGenericSlideReplacement(
          placeholderRequests,
          seen,
          slideObjectId,
          term,
          replacement,
        );
      }
      continue;
    }

    for (const term of nonCurrencyStaleTerms) {
      let replacement = targetLabel || market || client;
      const normalizedTerm = term.trim().toLowerCase();
      if (
        normalizedTerm === "uk" ||
        normalizedTerm === "wwt uk" ||
        normalizedTerm === "united kingdom" ||
        normalizedTerm === "au"
      ) {
        replacement = market || client || targetLabel;
      }
      if (replacement) {
        pushGenericSlideReplacement(updateRequests, seen, slideObjectId, term, replacement);
      }
    }

    if (/quarterly|performance report|qbr|report/i.test(slideText) && metadata.period) {
      pushGenericSlideReplacement(updateRequests, seen, slideObjectId, "Q1 2026", metadata.period);
    }

    const metricElements = textElements
      .filter((element) => asString(element.source) !== "table_cell")
      .map((element) => asString(element.text))
      .filter((text) => isLikelyMetricText(text) && !/^(?:[A-Z]{0,3}\$|£|\$|€)$/i.test(text.trim()));
    metricElements.slice(0, values.length).forEach((find, index) => {
      const replace = values[index];
      if (replace) {
        pushGenericSlideReplacement(updateRequests, seen, slideObjectId, find, replace);
      }
    });

    const longText = textElements
      .map((element) => asString(element.text))
      .filter((text) => text.length > 140)
      .at(-1);
    if (longText && /\b(uk|united kingdom|£|summary|performance|trend)\b/i.test(longText)) {
      pushGenericSlideReplacement(updateRequests, seen, slideObjectId, longText, commentary);
    }

    for (const term of currencyStaleTerms) {
      const replacement = currencyPrefix(metadata.currency);
      if (replacement) {
        pushGenericSlideReplacement(updateRequests, seen, slideObjectId, term, replacement);
      }
    }
  }

  return [...placeholderRequests, ...updateRequests].slice(0, 360);
}

function staleTermsForTarget(input: {
  targetMarket?: string;
  targetClient?: string;
  expectedCurrency?: string;
}) {
  const market = input.targetMarket?.toLowerCase() ?? "";
  const client = input.targetClient?.toLowerCase() ?? "";
  const terms: string[] = [];

  if (market.includes("australia") || /\bau\b/.test(market)) {
    terms.push("Wendy Wu Tours UK", "WWT UK", "United Kingdom", " UK ");
  }
  if (market.includes("uk") || market.includes("united kingdom")) {
    terms.push("Australia", " AU ");
  }
  if (client.includes("wendy wu") && market.includes("australia")) {
    terms.push("Wendy Wu Tours UK");
  }
  if (input.expectedCurrency && !["gbp", "£"].includes(input.expectedCurrency.toLowerCase())) {
    terms.push("£");
  }

  return Array.from(new Set(terms));
}

async function auditGoogleSlidesDeck(input: {
  workspaceId: string;
  presentationId: string;
  reportData: Record<string, unknown>;
  targetMarket?: string;
  targetClient?: string;
  expectedCurrency?: string;
}) {
  const deckMap = await inspectGoogleSlidesTemplate({
    workspaceId: input.workspaceId,
    presentationId: input.presentationId,
  });
  const deckText = normalizedDeckText(deckMap);
  const metadata = reportMetadataFromArtifact(input.reportData);
  const targetMarket = input.targetMarket || metadata.market;
  const targetClient = input.targetClient || metadata.client;
  const expectedCurrency = input.expectedCurrency || metadata.currency;
  const staleTerms = staleTermsForTarget({
    targetMarket,
    targetClient,
    expectedCurrency,
  });
  const staleReferences = staleTerms
    .map((term) => {
      const match = staleTermMatch(deckText, term);
      if (!match || typeof match.index !== "number") {
        return null;
      }
      const index = match.index;
      return {
        term,
        context: deckText.slice(Math.max(0, index - 80), index + term.length + 80),
      };
    })
    .filter(Boolean);
  const expectedValues = expectedReportValues(input.reportData);
  const missingExpectedValues = expectedValues.filter(
    (value) => !deckText.includes(value),
  );
  const slides = asObjectArray(deckMap.slides);
  const slideStatuses = slides.map((slide) => {
    const text = asObjectArray(slide.textElements)
      .map((element) => asString(element.text))
      .join("\n");
    const reasons: string[] = [];
    if (staleTerms.some((term) => staleTermMatches(text, term))) {
      reasons.push("Contains stale source-market or source-template text.");
    }
    if (/\bplaceholder|to be confirmed|human review|not provided|missing\b/i.test(text)) {
      reasons.push("Marked as placeholder or human-review content.");
    }

    const status = reasons.some((reason) => reason.includes("stale"))
      ? "needs-human-review"
      : reasons.length > 0
        ? "placeholder"
        : asString(slide.classification) === "section_divider"
          ? "unchanged-section-divider"
          : "updated-or-review";

    return {
      slideIndex: slide.slideIndex,
      slideObjectId: slide.slideObjectId,
      classification: slide.classification,
      status,
      reasons,
    };
  });
  const score = Math.max(
    0,
    100 - staleReferences.length * 10 - missingExpectedValues.length * 4,
  );
  const recommendations = [
    staleReferences.length > 0
      ? "Replace stale source-market references or explicitly mark those slides as placeholders."
      : "",
    missingExpectedValues.length > 0
      ? "Add missing calculated KPI values from report_data.json to the deck or explain why they are not applicable."
      : "",
    "Use deck-map element IDs for slide-scoped edits instead of broad global text replacement.",
  ].filter(Boolean);

  return {
    presentationId: input.presentationId,
    title: deckMap.title,
    targetClient,
    targetMarket,
    expectedCurrency,
    passed: staleReferences.length === 0 && missingExpectedValues.length <= 1,
    score,
    staleReferences,
    missingExpectedValues,
    slideStatuses,
    recommendations,
    deckMap,
  };
}

function formatIntegerMetric(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString("en-GB") : "";
}

function formatPercentMetric(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : "";
}

function deterministicSummaryMarkdown(input: {
  agentName: string;
  results: unknown[];
}) {
  const metrics = metricArtifactJson(input.results);
  const metadata = reportMetadataFromArtifact(metrics);
  const overall = reportOverallKpis(metrics);
  const deckLink = copiedPresentationLink(input.results);
  const lines = [
    `# ${input.agentName} output`,
    "",
    "Generated by the Summon generic tool runtime.",
    "",
    "## Generated deck",
    deckLink ? deckLink : "No deck link recorded.",
    "",
    "## Metrics calculated from sandbox output",
    `- Leads: ${formatIntegerMetric(overall.sales_leads) || "not found"}`,
    `- Spend: ${formatReportCurrency(overall.cost, metadata.currency || "GBP") || "not found"}`,
    `- CPL: ${formatReportDecimalCurrency(overall.cpl, metadata.currency || "GBP") || "not found"}`,
    `- CVR: ${formatPercentMetric(overall.cvr) || "not found"}`,
    `- CTR: ${formatPercentMetric(overall.ctr) || "not found"}`,
    "",
    "## Tool status",
    ...successfulToolResults(input.results).map(
      (result) => `- ${result.toolName}: ${result.status}`,
    ),
    "",
    "## Caveats",
    "- This summary is generated from tool outputs and uploaded/sandbox data.",
    "- Human review is still required before sending the deck externally.",
  ];

  return lines.join("\n");
}

function workflowGuardResult(missing: string[]) {
  return {
    type: "workflow_guard",
    status: "incomplete",
    missingRequiredOutcomes: missing,
    instruction:
      "The run prompt requires these outcomes. Continue with tool calls that complete at least one missing outcome; do not return an empty tool plan yet.",
  };
}

function deterministicWorkflowCalls(input: {
  agent: ToolLoopAgent;
  requirements: WorkflowRequirementState;
  toolResults: unknown[];
  availableTools: GenericAgentToolKey[];
}) {
  const calls: PlannedToolCall[] = [];
  const presentationId = copiedPresentationId(input.toolResults);
  const failedAudit = hasFailedDeckAudit(input.toolResults);
  const auditCount = successfulToolCount(input.toolResults, "google.slides.auditDeck");
  const inspectCount = successfulToolCount(input.toolResults, "google.slides.inspectTemplate");
  const batchUpdateCount = successfulToolCount(input.toolResults, "google.slides.batchUpdate");
  const latestTool = latestSuccessfulToolName(input.toolResults);
  const canAttemptAuditRepair = failedAudit && auditCount < 3;

  if (
    input.requirements.requiresSlidesDeckWrite &&
    presentationId &&
    input.availableTools.includes("google.slides.inspectTemplate") &&
    canAttemptAuditRepair &&
    latestTool === "google.slides.auditDeck" &&
    inspectCount <= auditCount
  ) {
    calls.push({
      tool: "google.slides.inspectTemplate",
      reason:
        "The deck audit failed. Reinspect the current copied deck so the repair batch targets the latest visible template content.",
      input: { presentationId },
    });
    return calls;
  }

  if (
    input.requirements.requiresSlidesDeckWrite &&
    presentationId &&
    input.availableTools.includes("google.slides.batchUpdate") &&
    canAttemptAuditRepair &&
    latestTool === "google.slides.inspectTemplate" &&
    batchUpdateCount <= auditCount
  ) {
    const requests = genericReportDeckBatchRequests(input.toolResults);
    if (requests.length > 0) {
      calls.push({
        tool: "google.slides.batchUpdate",
        reason:
          "Repair the copied deck after a failed audit using the latest deck map and structured report_data.json.",
        input: { presentationId, requests },
      });
      return calls;
    }
  }

  if (
    input.requirements.requiresSlidesDeckWrite &&
    presentationId &&
    input.availableTools.includes("google.slides.auditDeck") &&
    canAttemptAuditRepair &&
    latestTool === "google.slides.batchUpdate" &&
    auditCount <= batchUpdateCount
  ) {
    const reportData = metricArtifactJson(input.toolResults);
    calls.push({
      tool: "google.slides.auditDeck",
      reason: "Audit the repaired copied deck before allowing publication.",
      input: {
        presentationId,
        reportData,
      },
    });
    return calls;
  }

  if (
    input.requirements.requiresSlidesDeckWrite &&
    presentationId &&
    input.availableTools.includes("google.slides.inspectTemplate") &&
    !hasSuccessfulTool(input.toolResults, "google.slides.inspectTemplate")
  ) {
    calls.push({
      tool: "google.slides.inspectTemplate",
      reason:
        "Build a deck map with slide IDs, element IDs, tables, and layout classifications before targeted template editing.",
      input: { presentationId },
    });
    return calls;
  }

  if (
    input.requirements.requiresSlidesDeckWrite &&
    presentationId &&
    input.availableTools.includes("google.slides.readText") &&
    hasSuccessfulTool(input.toolResults, "google.slides.inspectTemplate") &&
    !hasSuccessfulTool(input.toolResults, "google.slides.readText")
  ) {
    calls.push({
      tool: "google.slides.readText",
      reason: "Read the copied deck text after inspection for compact planner context.",
      input: { presentationId },
    });
    return calls;
  }

  if (
    input.requirements.requiresSlidesDeckWrite &&
    presentationId &&
    input.availableTools.includes("google.slides.batchUpdate") &&
    hasSuccessfulTool(input.toolResults, "google.slides.inspectTemplate") &&
    !hasMeaningfulSlidesWrite(input.toolResults)
  ) {
    const requests = genericReportDeckBatchRequests(input.toolResults);
    if (requests.length > 0) {
      calls.push({
        tool: "google.slides.batchUpdate",
        reason:
          "Apply generic report-data updates from report_data.json to the run-owned copied deck before audit.",
        input: { presentationId, requests },
      });
      return calls;
    }
  }

  if (
    input.requirements.requiresSlidesDeckWrite &&
    presentationId &&
    input.availableTools.includes("google.slides.auditDeck") &&
    hasMeaningfulSlidesWrite(input.toolResults) &&
    !hasDeckAudit(input.toolResults)
  ) {
    const reportData = metricArtifactJson(input.toolResults);
    calls.push({
      tool: "google.slides.auditDeck",
      reason:
        "Audit the generated deck against calculated report data and target-market requirements before publishing.",
      input: {
        presentationId,
        reportData,
      },
    });
    return calls;
  }

  if (
    input.availableTools.includes("google.drive.createTextFile") &&
    hasMeaningfulSlidesWrite(input.toolResults) &&
    (!input.availableTools.includes("google.slides.auditDeck") ||
      hasPassingDeckAudit(input.toolResults)) &&
    !hasSuccessfulTool(input.toolResults, "google.drive.createTextFile")
  ) {
    calls.push({
      tool: "google.drive.createTextFile",
      reason: "Create a run-owned markdown summary artifact for the generated report.",
      input: {
        name: `${input.agent.name} - generated report summary.md`,
        mimeType: "text/markdown",
        content: deterministicSummaryMarkdown({
          agentName: input.agent.name,
          results: input.toolResults,
        }),
      },
    });
    return calls;
  }

  if (
    input.requirements.requiresNotionPublish &&
    hasMeaningfulSlidesWrite(input.toolResults) &&
    (!input.availableTools.includes("google.slides.auditDeck") ||
      hasPassingDeckAudit(input.toolResults)) &&
    !hasSuccessfulTool(input.toolResults, "notion.createPage")
  ) {
    const links = [
      {
        title: "Generated Google Slides deck",
        url: copiedPresentationLink(input.toolResults),
      },
      ...successfulToolResults(input.toolResults)
        .filter((result) => result.toolName === "google.drive.createTextFile")
        .map((result) => ({
          title: asString(asRecord(result.result).fileName, "Generated report summary"),
          url: asString(asRecord(result.result).webViewLink),
        })),
    ].filter((link) => link.url);

    calls.push({
      tool: "notion.createPage",
      reason: "Publish the generated report summary and artifact links into Notion memory.",
      input: {
        title: `${input.agent.name} - generated report`,
        content: deterministicSummaryMarkdown({
          agentName: input.agent.name,
          results: input.toolResults,
        }),
        links,
      },
    });
  }

  return calls;
}

function sumOptional(values: Array<number | undefined>) {
  const filtered = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );

  return filtered.length > 0
    ? filtered.reduce((total, value) => total + value, 0)
    : undefined;
}

function aggregateUsage(results: GenerateTextResult[]): LlmUsage | undefined {
  const usages = results.map((result) => result.usage).filter(Boolean);
  if (usages.length === 0) {
    return undefined;
  }

  return {
    inputTokens: sumOptional(usages.map((usage) => usage?.inputTokens)),
    outputTokens: sumOptional(usages.map((usage) => usage?.outputTokens)),
    totalTokens: sumOptional(usages.map((usage) => usage?.totalTokens)),
    raw: {
      source: "summed_tool_loop_llm_calls",
      calls: usages.length,
      usage: usages.map((usage) => usage?.raw ?? usage),
    },
  };
}

function aggregateEstimatedCost(results: GenerateTextResult[]) {
  const values = results
    .map((result) => result.estimatedCostUsd)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return values.length > 0
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function buildFallbackFinalResult(input: {
  provider: LlmProvider;
  model: string;
  toolResults: unknown[];
  protectedActionRequests: string[];
  llmResults: GenerateTextResult[];
  error: unknown;
}): GenerateTextResult {
  const message =
    input.error instanceof Error ? input.error.message : "Final response generation failed.";
  const compactResults = compactToolResultsForPrompt(input.toolResults);
  const toolRecords = compactResults.filter(isToolCallOutputRecord);
  const artifactLines = toolRecords
    .flatMap((record) => asObjectArray(record.artifacts))
    .map((artifact) => {
      const name = asString(artifact.name, "Artifact");
      const location = asString(artifact.location);
      return location ? `- ${name}: ${location}` : `- ${name}`;
    });

  const text = [
    "Tool execution completed, but the final LLM response step did not complete.",
    `Reason: ${message}`,
    "",
    "Generated artifacts:",
    artifactLines.length > 0 ? artifactLines.join("\n") : "- No artifact links were recorded.",
    "",
    "Tool call summary:",
    compactResults
      .map((result) => {
        const record = asRecord(result);
        return `- ${asString(record.toolName, "tool")}: ${asString(record.status, "unknown")}${
          record.error ? ` (${record.error})` : ""
        }`;
      })
      .join("\n"),
    "",
    input.protectedActionRequests.length > 0
      ? `Blocked protected actions: ${input.protectedActionRequests.join("; ")}`
      : "No protected actions were executed.",
  ].join("\n");

  return {
    provider: input.provider,
    model: input.model,
    text,
    usage: aggregateUsage(input.llmResults),
    estimatedCostUsd: aggregateEstimatedCost(input.llmResults),
  };
}

function buildDeterministicFinalResult(input: {
  provider: LlmProvider;
  model: string;
  agentName: string;
  toolResults: unknown[];
  protectedActionRequests: string[];
  llmResults: GenerateTextResult[];
}): GenerateTextResult {
  const compactResults = compactToolResultsForPrompt(input.toolResults);
  const toolRecords = compactResults.filter(isToolCallOutputRecord);
  const links = successfulToolResults(input.toolResults)
    .flatMap((result) => {
      const output = asRecord(result.result);
      return [
        {
          label:
            result.toolName === "google.slides.copyTemplate"
              ? "Generated Google Slides deck"
              : result.toolName === "google.docs.createDocument"
                ? "Generated Google Doc"
              : result.toolName === "google.drive.createTextFile"
                ? "Generated Drive summary"
                : result.toolName === "notion.createPage"
                  ? "Generated Notion memory page"
                  : "",
          url:
            asString(output.webViewLink) ||
            asString(output.pageUrl) ||
            asString(output.webContentLink),
        },
      ];
    })
    .filter((link) => link.label && link.url);

  const text = [
    deterministicSummaryMarkdown({
      agentName: input.agentName,
      results: input.toolResults,
    }),
    "",
    "## Published links",
    links.length > 0
      ? links.map((link) => `- ${link.label}: ${link.url}`).join("\n")
      : "- No published links were recorded.",
    "",
    "## Tool call summary",
    toolRecords
      .map((result) => {
        const record = asRecord(result);
        return `- ${asString(record.toolName, "tool")}: ${asString(record.status, "unknown")}${
          record.error ? ` (${record.error})` : ""
        }`;
      })
      .join("\n"),
    "",
    input.protectedActionRequests.length > 0
      ? `Blocked protected actions: ${input.protectedActionRequests.join("; ")}`
      : "No protected actions were executed.",
  ].join("\n");

  return {
    provider: input.provider,
    model: input.model,
    text,
    usage: aggregateUsage(input.llmResults),
    estimatedCostUsd: aggregateEstimatedCost(input.llmResults),
  };
}

function extractJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw new Error("Tool planner did not return JSON.");
  }

  return JSON.parse(candidate.slice(first, last + 1)) as unknown;
}

function parsePlannedToolCalls(text: string): PlannedToolCall[] {
  const parsed = asRecord(extractJsonObject(text));
  return asObjectArray(parsed.toolCalls)
    .slice(0, MAX_TOOL_CALLS_PER_ITERATION)
    .map((call) => ({
      tool: asString(call.tool),
      input: call.input,
      reason: asString(call.reason),
    }))
    .filter((call) => call.tool);
}

function selectedGenericTools(selectedTools: string[]) {
  return selectedTools.filter(isGenericAgentToolKey);
}

function toolDocs(toolKeys: GenericAgentToolKey[]) {
  return toolKeys
    .map((key) => {
      const definition = genericToolDefinition(key);
      return {
        tool: key,
        name: definition?.name ?? key,
        category: definition?.category ?? "Tool",
        summary: definition?.summary ?? "",
        inputSchema: schemaForTool(key),
      };
    })
    .filter(Boolean);
}

function schemaForTool(tool: GenericAgentToolKey) {
  switch (tool) {
    case "python.run":
      return {
        code: "optional Python source string; use when writing helper code for this run",
        entryFile: "optional uploaded .py filename to execute",
        args: "optional string[]",
      };
    case "google.drive.copyFile":
      return {
        fileUrl: "Google Drive/Docs/Sheets/Slides URL, optional when a template/reference is attached",
        fileId: "Google file id, optional alternative to fileUrl",
        name: "new copied file name",
      };
    case "google.drive.createTextFile":
      return {
        name: "file name",
        content: "text content",
        mimeType: "text/plain, text/csv, application/json, or text/markdown",
      };
    case "google.docs.createDocument":
      return {
        title: "new Google Doc title",
      };
    case "google.docs.readText":
      return {
        documentUrl: "Google Docs URL, optional alternative to documentId",
        documentId: "Google Docs document id",
      };
    case "google.docs.replaceText":
      return {
        documentId: "Doc id created/copied earlier in this run",
        replacements: "[{find, replace}] placeholder replacements",
      };
    case "google.docs.batchUpdate":
      return {
        documentId: "Doc id created/copied earlier in this run",
        requests: "Google Docs API batchUpdate requests",
      };
    case "google.sheets.readRange":
      return {
        spreadsheetUrl: "Google Sheets URL, optional alternative to spreadsheetId",
        spreadsheetId: "Google Sheets id",
        range: "A1 range, e.g. Sheet1!A1:D20",
      };
    case "google.sheets.updateRange":
      return {
        spreadsheetId: "Sheet id created/copied earlier in this run",
        range: "A1 range",
        values: "2D array of rows/cells",
      };
    case "google.slides.copyTemplate":
      return {
        presentationUrl: "Google Slides template URL, optional when a template is attached",
        presentationId: "template presentation id",
        name: "new deck name",
      };
    case "google.slides.readText":
      return {
        presentationUrl: "Google Slides URL, optional alternative to presentationId",
        presentationId: "Google Slides presentation id",
      };
    case "google.slides.inspectTemplate":
      return {
        presentationUrl: "Google Slides URL, optional alternative to presentationId",
        presentationId: "Google Slides presentation id",
      };
    case "google.slides.updateText":
      return {
        presentationId: "deck id created/copied earlier in this run",
        objectId: "shape/text element object id from inspectTemplate",
        text: "full replacement text for this text element",
      };
    case "google.slides.updateTableCell":
      return {
        presentationId: "deck id created/copied earlier in this run",
        tableObjectId: "table element object id from inspectTemplate",
        rowIndex: "zero-based table row index",
        columnIndex: "zero-based table column index",
        text: "full replacement text for this table cell",
      };
    case "google.slides.replaceText":
      return {
        presentationId: "deck id created/copied earlier in this run",
        replacements: "[{find, replace}] placeholder replacements",
      };
    case "google.slides.batchUpdate":
      return {
        presentationId: "deck id created/copied earlier in this run",
        requests: "Google Slides API batchUpdate requests",
      };
    case "google.slides.auditDeck":
      return {
        presentationId: "deck id created/copied earlier in this run",
        reportData:
          "optional structured report_data JSON from Python output; omit only if no report data exists",
        targetClient: "optional client name",
        targetMarket: "optional target market/region",
        expectedCurrency: "optional currency code or symbol",
      };
    case "notion.createPage":
      return {
        title: "page title",
        content: "plain text/markdown-like summary",
        links: "optional [{title,url}] artifact links",
      };
  }
}

function attachedFilesForPrompt(agent: ToolLoopAgent) {
  return agent.files.map((file) => ({
    id: file.id,
    name: file.name,
    role: file.role,
    sourceType: file.sourceType,
    url: file.url,
    originalFileName: file.originalFileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    description: file.description,
    contentPreview: file.contentText ? file.contentText.slice(0, 4000) : undefined,
  }));
}

function buildPlannerPrompt(input: {
  agent: ToolLoopAgent;
  basePrompt: string;
  availableTools: GenericAgentToolKey[];
  priorResults: unknown[];
  missingWorkflowOutcomes: string[];
}) {
  return [
    "You are planning tool calls for a Summon agent run.",
    "Return only JSON. Do not wrap it in prose.",
    "Use only the available tools listed below.",
    "Allowed without approval: reading data, running helper code in the sandbox, creating new files, copying templates, editing files created/copied in this same run, and creating Notion memory pages.",
    "Do not request destructive actions. Do not edit existing client/team files unless they were created or copied by this run.",
    "For Google Slides template work, first copy the template deck, then update the copied deck.",
    "For Google Docs template work, first copy or create the document, then replace placeholders or batch update only the copied/run-owned Doc.",
    "For Google Slides template work, use google.slides.inspectTemplate on the copied deck before editing so you can target slide IDs, element IDs, table cells, images/charts, and placeholder candidates.",
    "Prefer google.slides.updateText and google.slides.updateTableCell for precise slide-scoped edits. Use google.slides.batchUpdate for duplicated slides, new shapes, layout changes, and chart/image placeholder areas.",
    "Do not treat a visual template as trusted content. Replace stale source-market labels, copied commentary, and old KPI claims, or explicitly mark the slide as a human-editable placeholder.",
    "Python/report agents should produce a structured report_data.json artifact where possible: metadata, overall_kpis, trends, segment breakdowns, missing sections, and placeholder recommendations.",
    "For report decks, run google.slides.auditDeck after writing the copied deck. If it flags stale source-market text or missing KPI values, fix the deck and audit again.",
    "For google.slides.replaceText, match exact visible text inside a single text run. If a KPI value and label are separate, replace the standalone value, for example \"5,682\" instead of \"5,682 Total Leads\".",
    "After google.slides.replaceText, inspect replacementResults. If a required replacement has occurrencesChanged: 0, issue another replaceText with a narrower exact text or use batchUpdate against the copied deck.",
    "If the run prompt requires a generated deck, report, file, or memory page, keep calling tools until those artifacts are actually created or updated. Do not finalize from a copied/read-only artifact.",
    "If Required workflow outcomes below is non-empty, you must call tools to complete at least one missing outcome. Only return {\"toolCalls\":[]} when the missing outcomes are resolved or a tool failure makes them impossible.",
    "For Python work, use uploaded helper files or provide short generated Python in python.run.code.",
    "If no tool is needed, return {\"toolCalls\":[]}.",
    "",
    "Available tools:",
    JSON.stringify(toolDocs(input.availableTools), null, 2),
    "",
    "Attached files/references:",
    JSON.stringify(attachedFilesForPrompt(input.agent), null, 2),
    "",
    "Run prompt and connector context:",
    compactBasePromptForPlanner(input.basePrompt),
    "",
    "Prior tool results:",
    JSON.stringify(compactToolResultsForPrompt(input.priorResults), null, 2),
    "",
    "Required workflow outcomes still missing:",
    JSON.stringify(input.missingWorkflowOutcomes, null, 2),
    "",
    "JSON shape:",
    JSON.stringify(
      {
        toolCalls: [
          {
            tool: "python.run",
            reason: "why this tool is needed",
            input: {},
          },
        ],
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildFinalPrompt(input: {
  basePrompt: string;
  toolResults: unknown[];
  protectedActionRequests: string[];
  missingWorkflowOutcomes: string[];
}) {
  return [
    compactBasePromptForPlanner(input.basePrompt),
    "",
    "Tool execution results:",
    JSON.stringify(compactToolResultsForPrompt(input.toolResults), null, 2),
    "",
    "Write the final response for the Summon team.",
    "Include evidence used, generated artifacts with links, what was not verified, recommendations, and any blocked protected actions.",
    input.missingWorkflowOutcomes.length > 0
      ? `Unresolved required workflow outcomes: ${input.missingWorkflowOutcomes.join("; ")}. Be explicit that the run is incomplete.`
      : "All inferred required workflow outcomes were completed.",
    input.protectedActionRequests.length > 0
      ? `Blocked protected actions: ${input.protectedActionRequests.join("; ")}`
      : "No protected actions were executed.",
  ].join("\n");
}

function parseGoogleFileId(value: string) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    const idParam = url.searchParams.get("id");
    if (idParam) {
      return idParam;
    }
    const match = url.pathname.match(/\/(?:d|folders)\/([^/]+)/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Value may already be a raw id.
  }

  return value;
}

function firstAttachedGoogleFile(agent: ToolLoopAgent, options: {
  role?: string;
  urlPattern?: RegExp;
}) {
  return agent.files.find((file) => {
    if (!file.url) {
      return false;
    }
    if (options.role && file.role !== options.role) {
      return false;
    }
    return options.urlPattern ? options.urlPattern.test(file.url) : true;
  });
}

async function createArtifact(input: {
  agentRunId: string;
  toolCallId: string;
  artifactType: string;
  name: string;
  location?: string | null;
  mimeType?: string | null;
  payload?: Record<string, unknown>;
}) {
  return getDb().agentArtifact.create({
    data: {
      agentRunId: input.agentRunId,
      toolCallId: input.toolCallId,
      artifactType: input.artifactType,
      name: input.name,
      location: input.location,
      mimeType: input.mimeType,
      payload: input.payload ? toJsonValue(input.payload) : undefined,
    },
  });
}

function artifactOutput(artifact: Awaited<ReturnType<typeof createArtifact>>) {
  return {
    id: artifact.id,
    type: artifact.artifactType,
    name: artifact.name,
    location: artifact.location,
    mimeType: artifact.mimeType,
    payload: artifact.payload,
    status: "ready",
  };
}

function toolCallOutput(input: {
  id: string;
  toolName: string;
  status: string;
  input: unknown;
  result?: unknown;
  error?: string;
  artifacts?: unknown[];
}) {
  return {
    id: input.id,
    toolName: input.toolName,
    status: input.status.toLowerCase(),
    input: input.input,
    result: input.result,
    error: input.error,
    artifacts: input.artifacts ?? [],
  };
}

type ToolCallOutputRecord = ReturnType<typeof toolCallOutput>;

function isToolCallOutputRecord(value: unknown): value is ToolCallOutputRecord {
  return value !== null && typeof value === "object" && "toolName" in value;
}

function requireCreatedGoogleFile(state: RuntimeState, fileId: string, toolName: string) {
  if (state.createdGoogleFileIds.has(fileId)) {
    return;
  }

  const message = `${toolName} attempted to mutate an existing Google file (${fileId}). Approval is required before editing files that were not created or copied by this run.`;
  state.protectedActionRequests.push(message);
  throw new Error(message);
}

async function executeOneTool(input: {
  agentRunId: string;
  workspaceId: string;
  agent: ToolLoopAgent;
  call: PlannedToolCall;
  availableTools: GenericAgentToolKey[];
  state: RuntimeState;
}) {
  const db = getDb();
  const toolName = input.call.tool;
  const request = asRecord(input.call.input);
  const startedAt = Date.now();
  const toolCall = await db.toolCall.create({
    data: {
      agentRunId: input.agentRunId,
      connectorType: toolName.split(".")[0] ?? "tool",
      toolName,
      status: "RUNNING",
      startedAt: new Date(),
      request: toJsonValue({
        action: toolName,
        parameters: request,
      }),
      metadata: toJsonValue({
        reason: input.call.reason,
        selectedByAgent: true,
      }),
    },
  });

  if (!isGenericAgentToolKey(toolName) || !input.availableTools.includes(toolName)) {
    const error = `Tool ${toolName} is not selected for this agent.`;
    await db.toolCall.update({
      where: { id: toolCall.id },
      data: {
        status: "SKIPPED",
        error,
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });
    return toolCallOutput({
      id: toolCall.id,
      toolName,
      status: "SKIPPED",
      input: request,
      error,
    });
  }

  const artifacts: unknown[] = [];

  try {
    let result: unknown;

    if (toolName === "python.run") {
      const sandbox = await withLocalTimeout(
        runPythonInSandbox({
          runId: input.agentRunId,
          files: input.agent.files,
          code: asString(request.code),
          entryFile: asString(request.entryFile),
          args: asStringArray(request.args),
        }),
        "python.run",
        75_000,
      );
      const generatedArtifacts = [];
      for (const file of sandbox.generatedFiles) {
        let parsedJson: Record<string, unknown> | undefined;
        if (file.relativePath.toLowerCase().endsWith(".json") && file.contentPreview) {
          try {
            parsedJson = JSON.parse(file.contentPreview) as Record<string, unknown>;
          } catch {
            parsedJson = undefined;
          }
        }
        generatedArtifacts.push(
          artifactOutput(
            await createArtifact({
              agentRunId: input.agentRunId,
              toolCallId: toolCall.id,
              artifactType: "sandbox_file",
              name: file.relativePath,
              location: file.path,
              mimeType: "text/plain",
              payload: {
                sizeBytes: file.sizeBytes,
                contentPreview: file.contentPreview,
                ...(parsedJson ? { parsedJson } : {}),
              },
            }),
          ),
        );
      }
      artifacts.push(...generatedArtifacts);
      if (sandbox.timedOut) {
        throw new Error(
          `Python sandbox timed out after ${sandbox.durationMs}ms.\n${sandbox.stderr}`,
        );
      }
      if (sandbox.exitCode !== 0) {
        throw new Error(
          `Python sandbox exited with code ${sandbox.exitCode}.\n${sandbox.stderr}`,
        );
      }
      result = {
        command: sandbox.command,
        exitCode: sandbox.exitCode,
        timedOut: sandbox.timedOut,
        stdout: sandbox.stdout,
        stderr: sandbox.stderr,
        durationMs: sandbox.durationMs,
        files: generatedArtifacts,
      };
    }

    if (toolName === "google.drive.copyFile") {
      const attached = firstAttachedGoogleFile(input.agent, {
        role: "template",
      });
      const fileId = parseGoogleFileId(
        asString(request.fileId) || asString(request.fileUrl) || attached?.url || "",
      );
      if (!fileId) {
        throw new Error("google.drive.copyFile requires fileId, fileUrl, or an attached template/reference URL.");
      }
      const copied = await copyGoogleDriveFile({
        workspaceId: input.workspaceId,
        fileId,
        name: asString(request.name, `${input.agent.name} generated copy`),
      });
      input.state.createdGoogleFileIds.add(copied.fileId);
      input.state.createdGoogleFiles.push(copied);
      const artifact = artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "google_drive_file",
          name: copied.fileName,
          location: copied.webViewLink,
          mimeType: copied.mimeType,
          payload: copied,
        }),
      );
      artifacts.push(artifact);
      result = copied;
    }

    if (toolName === "google.drive.createTextFile") {
      const created = await createGoogleDriveTextFile({
        workspaceId: input.workspaceId,
        name: asString(request.name, `${input.agent.name} output.txt`),
        content: asString(request.content),
        mimeType: asString(request.mimeType, "text/plain"),
      });
      input.state.createdGoogleFileIds.add(created.fileId);
      input.state.createdGoogleFiles.push(created);
      const artifact = artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "google_drive_file",
          name: created.fileName,
          location: created.webViewLink,
          mimeType: created.mimeType,
          payload: created,
        }),
      );
      artifacts.push(artifact);
      result = created;
    }

    if (toolName === "google.docs.createDocument") {
      const created = await createGoogleDoc({
        workspaceId: input.workspaceId,
        title: asString(request.title, `${input.agent.name} generated doc`),
      });
      input.state.createdGoogleFileIds.add(created.fileId);
      input.state.createdGoogleFiles.push(created);
      const artifact = artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "google_doc",
          name: created.fileName,
          location: created.webViewLink,
          mimeType: created.mimeType,
          payload: created,
        }),
      );
      artifacts.push(artifact);
      result = created;
    }

    if (toolName === "google.docs.readText") {
      const attached = firstAttachedGoogleFile(input.agent, {
        urlPattern: /docs\.google\.com\/document/,
      });
      const documentId = parseGoogleFileId(
        asString(request.documentId) ||
          asString(request.documentUrl) ||
          attached?.url ||
          "",
      );
      if (!documentId) {
        throw new Error("google.docs.readText requires documentId, documentUrl, or an attached Google Docs URL.");
      }
      result = await readGoogleDocText({
        workspaceId: input.workspaceId,
        documentId,
      });
    }

    if (toolName === "google.docs.replaceText") {
      const documentId = parseGoogleFileId(asString(request.documentId));
      requireCreatedGoogleFile(input.state, documentId, toolName);
      const replacements = asObjectArray(request.replacements)
        .map((replacement) => ({
          find: asString(replacement.find),
          replace: asString(replacement.replace),
        }))
        .filter((replacement) => replacement.find);
      const replaceResult = await replaceGoogleDocText({
        workspaceId: input.workspaceId,
        documentId,
        replacements,
      });
      const replies = asObjectArray(asRecord(replaceResult).replies);
      result = {
        ...asRecord(replaceResult),
        replacementResults: replacements.map((replacement, index) => {
          const reply = asRecord(replies[index]);
          const replaceAllText = asRecord(reply.replaceAllText);
          const occurrencesChanged =
            typeof replaceAllText.occurrencesChanged === "number"
              ? replaceAllText.occurrencesChanged
              : 0;

          return {
            ...replacement,
            occurrencesChanged,
          };
        }),
      };
    }

    if (toolName === "google.docs.batchUpdate") {
      const documentId = parseGoogleFileId(asString(request.documentId));
      requireCreatedGoogleFile(input.state, documentId, toolName);
      result = await batchUpdateGoogleDoc({
        workspaceId: input.workspaceId,
        documentId,
        requests: asObjectArray(request.requests),
      });
    }

    if (toolName === "google.sheets.readRange") {
      const spreadsheetId = parseGoogleFileId(
        asString(request.spreadsheetId) || asString(request.spreadsheetUrl),
      );
      const range = asString(request.range, "A1:Z100");
      if (!spreadsheetId) {
        throw new Error("google.sheets.readRange requires spreadsheetId or spreadsheetUrl.");
      }
      result = await readGoogleSheetRange({
        workspaceId: input.workspaceId,
        spreadsheetId,
        range,
      });
    }

    if (toolName === "google.sheets.updateRange") {
      const spreadsheetId = parseGoogleFileId(asString(request.spreadsheetId));
      requireCreatedGoogleFile(input.state, spreadsheetId, toolName);
      const values = Array.isArray(request.values) ? (request.values as unknown[][]) : [];
      result = await updateGoogleSheetRange({
        workspaceId: input.workspaceId,
        spreadsheetId,
        range: asString(request.range, "A1"),
        values,
      });
    }

    if (toolName === "google.slides.copyTemplate") {
      const attached = firstAttachedGoogleFile(input.agent, {
        role: "template",
        urlPattern: /docs\.google\.com\/presentation/,
      });
      const presentationId = parseGoogleFileId(
        asString(request.presentationId) ||
          asString(request.presentationUrl) ||
          attached?.url ||
          "",
      );
      if (!presentationId) {
        throw new Error("google.slides.copyTemplate requires presentationId, presentationUrl, or an attached Slides template.");
      }
      const copied = await copyGoogleDriveFile({
        workspaceId: input.workspaceId,
        fileId: presentationId,
        name: asString(request.name, `${input.agent.name} generated deck`),
      });
      input.state.createdGoogleFileIds.add(copied.fileId);
      input.state.createdGoogleFiles.push(copied);
      const artifact = artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "google_slides",
          name: copied.fileName,
          location: copied.webViewLink,
          mimeType: copied.mimeType,
          payload: copied,
        }),
      );
      artifacts.push(artifact);
      result = {
        presentationId: copied.fileId,
        ...copied,
      };
    }

    if (toolName === "google.slides.readText") {
      const attached = firstAttachedGoogleFile(input.agent, {
        role: "template",
        urlPattern: /docs\.google\.com\/presentation/,
      });
      const presentationId = parseGoogleFileId(
        asString(request.presentationId) ||
          asString(request.presentationUrl) ||
          attached?.url ||
          "",
      );
      if (!presentationId) {
        throw new Error("google.slides.readText requires presentationId, presentationUrl, or an attached Slides template.");
      }
      result = await readGoogleSlidesText({
        workspaceId: input.workspaceId,
        presentationId,
      });
    }

    if (toolName === "google.slides.inspectTemplate") {
      const attached = firstAttachedGoogleFile(input.agent, {
        role: "template",
        urlPattern: /docs\.google\.com\/presentation/,
      });
      const presentationId = parseGoogleFileId(
        asString(request.presentationId) ||
          asString(request.presentationUrl) ||
          attached?.url ||
          "",
      );
      if (!presentationId) {
        throw new Error("google.slides.inspectTemplate requires presentationId, presentationUrl, or an attached Slides template.");
      }
      result = await inspectGoogleSlidesTemplate({
        workspaceId: input.workspaceId,
        presentationId,
      });
      const artifact = artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "deck_map",
          name: "deck_map.json",
          location: null,
          mimeType: "application/json",
          payload: asRecord(result),
        }),
      );
      artifacts.push(artifact);
    }

    if (toolName === "google.slides.updateText") {
      const presentationId = parseGoogleFileId(asString(request.presentationId));
      requireCreatedGoogleFile(input.state, presentationId, toolName);
      const objectId = asString(request.objectId);
      if (!objectId) {
        throw new Error("google.slides.updateText requires objectId from google.slides.inspectTemplate.");
      }
      result = await updateGoogleSlidesTextElement({
        workspaceId: input.workspaceId,
        presentationId,
        objectId,
        text: asString(request.text),
      });
    }

    if (toolName === "google.slides.updateTableCell") {
      const presentationId = parseGoogleFileId(asString(request.presentationId));
      requireCreatedGoogleFile(input.state, presentationId, toolName);
      const tableObjectId = asString(request.tableObjectId);
      if (!tableObjectId) {
        throw new Error("google.slides.updateTableCell requires tableObjectId from google.slides.inspectTemplate.");
      }
      result = await updateGoogleSlidesTableCell({
        workspaceId: input.workspaceId,
        presentationId,
        tableObjectId,
        rowIndex: Number(request.rowIndex),
        columnIndex: Number(request.columnIndex),
        text: asString(request.text),
      });
    }

    if (toolName === "google.slides.replaceText") {
      const presentationId = parseGoogleFileId(asString(request.presentationId));
      requireCreatedGoogleFile(input.state, presentationId, toolName);
      const replacements = asObjectArray(request.replacements).map((replacement) => ({
        find: asString(replacement.find),
        replace: asString(replacement.replace),
      })).filter((replacement) => replacement.find);
      const replaceResult = await replaceGoogleSlidesText({
        workspaceId: input.workspaceId,
        presentationId,
        replacements,
      });
      const replies = asObjectArray(asRecord(replaceResult).replies);
      result = {
        ...asRecord(replaceResult),
        replacementResults: replacements.map((replacement, index) => {
          const reply = asRecord(replies[index]);
          const replaceAllText = asRecord(reply.replaceAllText);
          const occurrencesChanged =
            typeof replaceAllText.occurrencesChanged === "number"
              ? replaceAllText.occurrencesChanged
              : 0;

          return {
            ...replacement,
            occurrencesChanged,
          };
        }),
      };
    }

    if (toolName === "google.slides.batchUpdate") {
      const presentationId = parseGoogleFileId(asString(request.presentationId));
      requireCreatedGoogleFile(input.state, presentationId, toolName);
      result = await batchUpdateGoogleSlides({
        workspaceId: input.workspaceId,
        presentationId,
        requests: asObjectArray(request.requests),
      });
    }

    if (toolName === "google.slides.auditDeck") {
      const presentationId = parseGoogleFileId(asString(request.presentationId));
      requireCreatedGoogleFile(input.state, presentationId, toolName);
      const reportData =
        Object.keys(asRecord(request.reportData)).length > 0
          ? asRecord(request.reportData)
          : metricArtifactJson([]);
      result = await auditGoogleSlidesDeck({
        workspaceId: input.workspaceId,
        presentationId,
        reportData,
        targetClient: asString(request.targetClient),
        targetMarket: asString(request.targetMarket),
        expectedCurrency: asString(request.expectedCurrency),
      });
      const auditResult = asRecord(result);
      const artifact = artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "deck_audit",
          name: "deck_audit.json",
          location: null,
          mimeType: "application/json",
          payload: asRecord(result),
        }),
      );
      artifacts.push(artifact);
      result = {
        presentationId: auditResult.presentationId,
        title: auditResult.title,
        targetClient: auditResult.targetClient,
        targetMarket: auditResult.targetMarket,
        expectedCurrency: auditResult.expectedCurrency,
        passed: auditResult.passed,
        score: auditResult.score,
        staleReferences: auditResult.staleReferences,
        missingExpectedValues: auditResult.missingExpectedValues,
        slideStatuses: auditResult.slideStatuses,
        recommendations: auditResult.recommendations,
      };
    }

    if (toolName === "notion.createPage") {
      const links = asObjectArray(request.links)
        .map((link) => ({
          title: asString(link.title, "Artifact"),
          url: asString(link.url),
        }))
        .filter((link) => link.url);
      result = await createNotionPage({
        workspaceId: input.workspaceId,
        title: asString(request.title, `${input.agent.name} output`),
        content: asString(request.content),
        links,
      });
    }

    await db.toolCall.update({
      where: { id: toolCall.id },
      data: {
        status: "SUCCEEDED",
        response: toJsonValue(result),
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });

    return toolCallOutput({
      id: toolCall.id,
      toolName,
      status: "SUCCEEDED",
      input: request,
      result,
      artifacts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    await db.toolCall.update({
      where: { id: toolCall.id },
      data: {
        status: message.includes("Approval is required") ? "BLOCKED" : "FAILED",
        error: message,
        completedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });

    return toolCallOutput({
      id: toolCall.id,
      toolName,
      status: message.includes("Approval is required") ? "BLOCKED" : "FAILED",
      input: request,
      error: message,
      artifacts,
    });
  }
}

export async function runAgentToolLoop(input: ToolLoopInput) {
  const availableTools = selectedGenericTools(input.selectedTools);
  if (availableTools.length === 0) {
    return {
      toolResults: [] as unknown[],
      toolCalls: [] as Prisma.InputJsonValue[],
      artifacts: [] as Prisma.InputJsonValue[],
      protectedActionRequests: [] as string[],
      unresolvedWorkflowOutcomes: [] as string[],
      workflowStatus: "complete",
      createdGoogleFiles: [] as RuntimeState["createdGoogleFiles"],
    };
  }

  const client = createLlmClient(input.provider);
  const state: RuntimeState = {
    createdGoogleFileIds: new Set(),
    createdGoogleFiles: [],
    protectedActionRequests: [],
  };
  const workflowRequirements = inferWorkflowRequirements({
    agent: input.agent,
    basePrompt: input.basePrompt,
    availableTools,
  });
  const toolResults: unknown[] = [];
  const llmResults: GenerateTextResult[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const missingOutcomes = missingWorkflowOutcomes({
      requirements: workflowRequirements,
      toolResults,
      availableTools,
    });
    const deterministicCalls = deterministicWorkflowCalls({
      agent: input.agent,
      requirements: workflowRequirements,
      toolResults,
      availableTools,
    });

    if (deterministicCalls.length > 0) {
      for (const call of deterministicCalls) {
        toolResults.push(
          await executeOneTool({
            agentRunId: input.agentRunId,
            workspaceId: input.workspaceId,
            agent: input.agent,
            call,
            availableTools,
            state,
          }),
        );
      }
      continue;
    }

    let plan: GenerateTextResult;
    try {
      plan = await withLocalTimeout(
        client.generateText({
          systemPrompt: input.systemPrompt,
          model: input.model,
          prompt: buildPlannerPrompt({
            agent: input.agent,
            basePrompt: input.basePrompt,
            availableTools,
            priorResults: toolResults,
            missingWorkflowOutcomes: missingOutcomes,
          }),
        }),
        "Tool planner",
        TOOL_LLM_TIMEOUT_MS,
      );
      llmResults.push(plan);
    } catch (error) {
      if (missingOutcomes.length > 0 && iteration < MAX_TOOL_ITERATIONS - 1) {
        toolResults.push(
          workflowGuardResult([
            ...missingOutcomes,
            `Previous planner call failed: ${
              error instanceof Error ? error.message : "Unable to parse planner response."
            }`,
          ]),
        );
        continue;
      }
      if (toolResults.length > 0) {
        break;
      }
      throw error;
    }

    let calls: PlannedToolCall[] = [];
    try {
      calls = parsePlannedToolCalls(plan.text);
    } catch {
      if (missingOutcomes.length > 0 && iteration < MAX_TOOL_ITERATIONS - 1) {
        toolResults.push(
          workflowGuardResult([
            ...missingOutcomes,
            "Previous planner response was not valid JSON. Continue with valid JSON tool calls.",
          ]),
        );
        continue;
      }
      break;
    }

    if (calls.length === 0) {
      if (missingOutcomes.length > 0 && iteration < MAX_TOOL_ITERATIONS - 1) {
        toolResults.push(workflowGuardResult(missingOutcomes));
        continue;
      }
      break;
    }

    for (const call of calls) {
      toolResults.push(
        await executeOneTool({
          agentRunId: input.agentRunId,
          workspaceId: input.workspaceId,
          agent: input.agent,
          call,
          availableTools,
          state,
        }),
      );
    }
  }

  const unresolvedWorkflowOutcomes = missingWorkflowOutcomes({
    requirements: workflowRequirements,
    toolResults,
    availableTools,
  });

  let final: GenerateTextResult;
  if (
    unresolvedWorkflowOutcomes.length === 0 &&
    toolResults.length >= 6 &&
    (hasMeaningfulSlidesWrite(toolResults) ||
      hasSuccessfulTool(toolResults, "google.drive.createTextFile") ||
      hasSuccessfulTool(toolResults, "notion.createPage"))
  ) {
    final = buildDeterministicFinalResult({
      provider: input.provider,
      model: input.model,
      agentName: input.agent.name,
      toolResults,
      protectedActionRequests: state.protectedActionRequests,
      llmResults,
    });
  } else {
    try {
    final = await withLocalTimeout(
      client.generateText({
        systemPrompt: input.systemPrompt,
        model: input.model,
        prompt: buildFinalPrompt({
          basePrompt: input.basePrompt,
          toolResults,
          protectedActionRequests: state.protectedActionRequests,
          missingWorkflowOutcomes: unresolvedWorkflowOutcomes,
        }),
      }),
      "Final response",
      FINAL_LLM_TIMEOUT_MS,
    );
    llmResults.push(final);
  } catch (error) {
    if (toolResults.length === 0) {
      throw error;
    }
    final = buildFallbackFinalResult({
      provider: input.provider,
      model: input.model,
      toolResults,
      protectedActionRequests: state.protectedActionRequests,
      llmResults,
      error,
    });
  }
  }

  const toolCallRecords = toolResults.filter(isToolCallOutputRecord);
  const toolCalls = toolCallRecords.map((result) => toJsonValue(result));
  const artifacts = toolCallRecords
    .flatMap((result) => result.artifacts ?? [])
    .map((artifact) => toJsonValue(artifact));

  return {
    final,
    toolResults,
    toolCalls,
    artifacts,
    protectedActionRequests: state.protectedActionRequests,
    unresolvedWorkflowOutcomes,
    workflowStatus: unresolvedWorkflowOutcomes.length > 0 ? "incomplete" : "complete",
    createdGoogleFiles: state.createdGoogleFiles,
    output: {
      text: final.text,
      provider: final.provider,
      model: final.model,
      usage: final.usage,
      estimatedCostUsd: final.estimatedCostUsd,
    },
  };
}

export function genericToolInstruction() {
  return [
    "Generic agent tools are available only when selected on the agent.",
    `Supported generic tools: ${GENERIC_AGENT_TOOLS.map((tool) => tool.key).join(", ")}.`,
    "Use tools for real work instead of pretending they ran.",
    "When a task asks for generated artifacts such as decks, reports, files, or memory pages, do not stop after reading context; create or update the requested run-owned outputs.",
    "Create/copy/write only run-owned outputs unless approval is explicitly granted.",
  ].join("\n");
}

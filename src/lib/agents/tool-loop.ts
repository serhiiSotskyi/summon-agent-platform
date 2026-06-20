import { Prisma, type Agent, type AgentFile } from "@prisma/client";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  batchUpdateGoogleDoc,
  batchUpdateGoogleSlides,
  copyGoogleDriveFile,
  createGoogleDoc,
  createGoogleDriveBinaryFile,
  createGoogleDriveTextFile,
  createGoogleSheet,
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
  normalizeAgentToolSelection,
  type GenericAgentToolKey,
} from "@/lib/tools/definitions";
import { runPythonInSandbox } from "@/lib/tools/python-sandbox";

const MAX_TOOL_ITERATIONS = 12;
const MAX_TOOL_CALLS_PER_ITERATION = 5;
const MAX_DETERMINISTIC_FINALIZATION_STEPS = 8;
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

type ToolResultFocus = {
  slideObjectIds: Set<string>;
};

type DeckAuditBlockingIssue = {
  slideObjectId: string;
  reasons: string[];
};

function latestToolResultFocus(results: unknown[]): ToolResultFocus | undefined {
  const latestAudit = successfulToolResults(results)
    .filter((result) => result.toolName === "google.slides.auditDeck")
    .at(-1);
  const auditResult = asRecord(latestAudit?.result);
  const blockingSlideIssues = asObjectArray(auditResult.blockingSlideIssues);
  const slideObjectIds = new Set(
    blockingSlideIssues.map((issue) => asString(issue.slideObjectId)).filter(Boolean),
  );

  return slideObjectIds.size > 0 ? { slideObjectIds } : undefined;
}

function latestDeckAuditBlockingIssues(results: unknown[]) {
  const latestAudit = successfulToolResults(results)
    .filter((result) => result.toolName === "google.slides.auditDeck")
    .at(-1);
  const auditResult = asRecord(latestAudit?.result);
  const issuesBySlide = new Map<string, DeckAuditBlockingIssue>();

  for (const issue of asObjectArray(auditResult.blockingSlideIssues)) {
    const slideObjectId = asString(issue.slideObjectId);
    if (!slideObjectId) {
      continue;
    }
    const reasons = asStringArray(issue.reasons);
    issuesBySlide.set(slideObjectId, {
      slideObjectId,
      reasons,
    });
  }

  return issuesBySlide;
}

function auditIssueRequiresPlaceholder(reasons: string[]) {
  return reasons.some((reason) =>
    /must be a placeholder|missing core segment values|no segment-level trend data|appears to use overall report metrics/i.test(
      reason,
    ),
  );
}

function compactDeckMapPayload(payload: Record<string, unknown>, focus?: ToolResultFocus) {
  const slides = asObjectArray(payload.slides);
  const focusedSlides =
    focus && focus.slideObjectIds.size > 0
      ? slides.filter((slide) => focus.slideObjectIds.has(asString(slide.slideObjectId)))
      : slides.slice(0, 8);

  return {
    title: payload.title,
    presentationId: payload.presentationId,
    slideCount: slides.length,
    slides: focusedSlides.map((slide) => ({
      slideIndex: slide.slideIndex,
      slideObjectId: slide.slideObjectId,
      classification: slide.classification,
      titleCandidate: compactText(slide.titleCandidate, 180),
      textElements: asObjectArray(slide.textElements)
        .slice(0, 10)
        .map((element) => ({
          objectId: element.objectId,
          source: element.source,
          rowIndex: element.rowIndex,
          columnIndex: element.columnIndex,
          text: compactText(element.text, 220),
        })),
      pageElements: asObjectArray(slide.pageElements)
        .slice(0, 10)
        .map((element) => ({
          objectId: element.objectId,
          type: element.type,
          shapeType: element.shapeType,
          text: compactText(element.text, 140),
          table: element.table
            ? {
                rowCount: asRecord(element.table).rowCount,
                columnCount: asRecord(element.table).columnCount,
              }
            : null,
        })),
    })),
  };
}

function compactAuditPayload(payload: Record<string, unknown>) {
  return {
    presentationId: payload.presentationId,
    title: payload.title,
    passed: payload.passed,
    score: payload.score,
    staleReferences: asObjectArray(payload.staleReferences).slice(0, 12),
    missingExpectedValues: asStringArray(payload.missingExpectedValues).slice(0, 12),
    blockingSlideIssues: asObjectArray(payload.blockingSlideIssues).slice(0, 20),
    recommendations: asStringArray(payload.recommendations).slice(0, 8),
  };
}

function compactParsedJsonForPrompt(name: string, value: unknown) {
  const parsed = asRecord(value);
  if (Object.keys(parsed).length === 0) {
    return undefined;
  }

  if (name.includes("report_data") || name.includes("metrics")) {
    return {
      metadata: parsed.metadata,
      overall_kpis: parsed.overall_kpis ?? parsed.overall,
      campaign_type_breakdowns: parsed.campaign_type_breakdowns,
      destination_breakdowns: parsed.destination_breakdowns,
      missing_data_sections: parsed.missing_data_sections,
      recommended_placeholder_slides: parsed.recommended_placeholder_slides,
    };
  }

  return parsed;
}

function compactGeneratedFileForPrompt(value: unknown, focus?: ToolResultFocus) {
  const file = asRecord(value);
  const payload = asRecord(file.payload);
  const name = asString(file.name, "artifact");
  const mimeType = asString(file.mimeType);
  const artifactType = asString(file.type, asString(file.artifactType));

  if (artifactType === "deck_map" || name.toLowerCase() === "deck_map.json") {
    return {
      id: file.id,
      type: file.type,
      name,
      location: file.location,
      mimeType: file.mimeType,
      status: file.status,
      payload: compactDeckMapPayload(payload, focus),
    };
  }

  if (artifactType === "deck_audit" || name.toLowerCase() === "deck_audit.json") {
    return {
      id: file.id,
      type: file.type,
      name,
      location: file.location,
      mimeType: file.mimeType,
      status: file.status,
      payload: compactAuditPayload(payload),
    };
  }

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
      parsedJson: compactParsedJsonForPrompt(name.toLowerCase(), payload.parsedJson),
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
    toolName === "google.docs.createDocument" ||
    toolName === "google.sheets.createSpreadsheet"
  ) {
    return {
      title: input.title,
      sheetTitle: input.sheetTitle,
      name: input.name,
      mimeType: input.mimeType,
      content: compactText(input.content, 1600),
      rows: Array.isArray(input.rows)
        ? {
            rowCount: input.rows.length,
            firstRows: input.rows.slice(0, 3),
          }
        : undefined,
      links: input.links,
    };
  }

  return input;
}

function compactToolResultForPrompt(value: unknown, focus?: ToolResultFocus) {
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
    artifacts: asObjectArray(record.artifacts).map((artifact) =>
      compactGeneratedFileForPrompt(artifact, focus),
    ),
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
        files: asObjectArray(result.files).map((file) =>
          compactGeneratedFileForPrompt(file, focus),
        ),
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
    const slides = asObjectArray(result.slides);
    const focusedSlides =
      focus && focus.slideObjectIds.size > 0
        ? slides.filter((slide) => focus.slideObjectIds.has(asString(slide.slideObjectId)))
        : slides.slice(0, 16);
    return {
      ...base,
      result: {
        presentationId: result.presentationId,
        title: result.title,
        slideCount: slides.length,
        slides: focusedSlides.map((slide) => ({
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
    const slides = asObjectArray(result.slides);
    const focusedSlides =
      focus && focus.slideObjectIds.size > 0
        ? slides.filter((slide) => focus.slideObjectIds.has(asString(slide.slideObjectId)))
        : slides.slice(0, 24);
    return {
      ...base,
      result: {
        presentationId: result.presentationId,
        title: result.title,
        slideCount: slides.length,
        slides: focusedSlides.map((slide) => ({
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
        blockingSlideIssues: asObjectArray(result.blockingSlideIssues).slice(0, 20),
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
  const focus = latestToolResultFocus(results);
  return results.map((result) => compactToolResultForPrompt(result, focus));
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

function compactConnectorEvidenceForFinalPrompt(basePrompt: string) {
  const marker = "\nConnector evidence:";
  const markerIndex = basePrompt.indexOf(marker);
  if (markerIndex < 0) {
    return "No connector evidence section was supplied.";
  }

  const rawEvidence = basePrompt.slice(markerIndex + marker.length).trim();
  if (!rawEvidence) {
    return "Connector evidence section was supplied but empty.";
  }

  try {
    const contexts = asObjectArray(JSON.parse(rawEvidence));
    const compactContexts = contexts.map((context) => ({
      connectorType: context.connectorType,
      connectorName: context.connectorName,
      status: context.status,
      summary: compactText(context.summary, 600),
      blockers: asStringArray(context.blockers),
      records: asObjectArray(context.records)
        .slice(0, 12)
        .map((record) => ({
          source: record.source,
          title: record.title,
          url: record.url,
          type: record.type,
          query: record.query,
          lastUpdated: record.lastUpdated,
          evidenceId: record.evidenceId,
          snippet: compactText(record.snippet, 900),
          exportError: record.exportError,
        })),
    }));

    return JSON.stringify(compactContexts, null, 2);
  } catch {
    return compactText(rawEvidence, 12000) as string;
  }
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

function numericMetric(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstNumericMetric(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = numericMetric(record[key]);
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function roundedDecimal(value: number, places: number) {
  return value.toLocaleString("en-GB", {
    maximumFractionDigits: places,
    minimumFractionDigits: places,
  });
}

function metricValueVariants(input: {
  value: unknown;
  kind: "integer" | "currency" | "decimalCurrency" | "percent" | "decimal";
  currency: string;
  compactCurrency?: boolean;
}) {
  const number = numericMetric(input.value);
  if (typeof number !== "number") {
    return [];
  }

  const variants = new Set<string>();
  if (input.kind === "integer") {
    variants.add(Math.round(number).toLocaleString("en-GB"));
    variants.add(roundedDecimal(number, 1));
    variants.add(roundedDecimal(number, 2));
  }
  if (input.kind === "currency") {
    variants.add(formatReportCurrency(number, input.currency, Boolean(input.compactCurrency)));
    variants.add(formatReportCurrency(number, input.currency, false));
    variants.add(formatReportDecimalCurrency(number, input.currency));
    variants.add(`${currencyPrefix(input.currency)}${roundedDecimal(number, 1)}`);
  }
  if (input.kind === "decimalCurrency") {
    variants.add(formatReportDecimalCurrency(number, input.currency));
    variants.add(formatReportCurrency(number, input.currency, false));
  }
  if (input.kind === "percent") {
    variants.add(formatPercentMetric(number));
    variants.add(`${(number * 100).toFixed(1)}%`);
    variants.add(`${Math.round(number * 100)}%`);
  }
  if (input.kind === "decimal") {
    variants.add(roundedDecimal(number, 2));
    variants.add(roundedDecimal(number, 1));
  }

  return Array.from(variants).filter(Boolean);
}

function reportMetricGroupsForRecord(
  record: Record<string, unknown>,
  reportData: Record<string, unknown>,
  compactCost = false,
) {
  const metadata = reportMetadataFromArtifact(reportData);
  const currency = metadata.currency || "GBP";
  const metricInputs: Array<{
    key: string;
    value: number | undefined;
    kind: "integer" | "currency" | "decimalCurrency" | "percent" | "decimal";
    replacement: string;
  }> = [
    {
      key: "leads",
      value: firstNumericMetric(record, ["sales_leads", "leads", "conversions"]),
      kind: "integer",
      replacement: formatIntegerMetric(record.sales_leads ?? record.leads ?? record.conversions),
    },
    {
      key: "cost",
      value: firstNumericMetric(record, ["cost", "spend"]),
      kind: "currency",
      replacement: formatReportCurrency(record.cost ?? record.spend, currency, compactCost),
    },
    {
      key: "cpl",
      value: firstNumericMetric(record, ["cpl", "cost_per_lead"]),
      kind: "decimalCurrency",
      replacement: formatReportDecimalCurrency(record.cpl ?? record.cost_per_lead, currency),
    },
    {
      key: "cvr",
      value: firstNumericMetric(record, ["cvr", "conversion_rate"]),
      kind: "percent",
      replacement: formatPercentMetric(record.cvr ?? record.conversion_rate),
    },
    {
      key: "clicks",
      value: firstNumericMetric(record, ["clicks"]),
      kind: "integer",
      replacement: formatIntegerMetric(record.clicks),
    },
    {
      key: "ctr",
      value: firstNumericMetric(record, ["ctr", "click_through_rate"]),
      kind: "percent",
      replacement: formatPercentMetric(record.ctr ?? record.click_through_rate),
    },
    {
      key: "impressions",
      value: firstNumericMetric(record, ["impressions"]),
      kind: "integer",
      replacement: formatIntegerMetric(record.impressions),
    },
    {
      key: "cpc",
      value: firstNumericMetric(record, ["cpc", "cost_per_click"]),
      kind: "decimalCurrency",
      replacement: formatReportDecimalCurrency(record.cpc ?? record.cost_per_click, currency),
    },
  ];

  return metricInputs
    .filter((metric): metric is typeof metric & { value: number } =>
      typeof metric.value === "number" && Boolean(metric.replacement),
    )
    .map((metric) => ({
      key: metric.key,
      value: metric.value,
      replacement: metric.replacement,
      variants: metricValueVariants({
        value: metric.value,
        kind: metric.kind,
        currency,
        compactCurrency: compactCost,
      }),
    }));
}

function genericReportMetricValues(reportData: Record<string, unknown>, compactCost = false) {
  const overall = reportOverallKpis(reportData);
  return reportMetricGroupsForRecord(overall, reportData, compactCost)
    .filter((group) => ["leads", "cost", "cpl", "cvr", "clicks", "ctr"].includes(group.key))
    .map((group) => group.replacement)
    .filter(Boolean);
}

function normalizedReportLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function reportSegmentArrays(reportData: Record<string, unknown>) {
  return [
    {
      category: "campaign",
      candidates: [
        reportData.campaign_type_breakdowns,
        reportData.campaign_type_breakdown,
        reportData.campaign_breakdowns,
        reportData.campaign_breakdown,
        reportData.campaigns,
      ],
      labelKeys: ["campaign_type", "campaignType", "campaign", "type", "name", "label"],
    },
    {
      category: "destination",
      candidates: [
        reportData.destination_breakdowns,
        reportData.destination_breakdown,
        reportData.destinations,
        reportData.destination,
        reportData.segment_breakdowns,
        reportData.segment_breakdown,
      ],
      labelKeys: ["destination", "segment", "market", "name", "label"],
    },
  ] as const;
}

function reportSegments(reportData: Record<string, unknown>) {
  const segments: Array<{
    category: "campaign" | "destination";
    label: string;
    metrics: Record<string, unknown>;
    aliases: string[];
  }> = [];

  for (const group of reportSegmentArrays(reportData)) {
    for (const candidate of group.candidates) {
      const rows: Record<string, unknown>[] = Array.isArray(candidate)
        ? asObjectArray(candidate)
        : Object.entries(asRecord(candidate)).map(([label, metrics]) => ({
            label,
            ...asRecord(metrics),
          }));

      for (const row of rows) {
        const label =
          group.labelKeys.map((key) => asString(row[key])).find(Boolean) ||
          asString(row.label);
        if (!label) {
          continue;
        }
        const normalized = normalizedReportLabel(label);
        const aliases = new Set([normalized]);
        if (normalized === "performance max") {
          aliases.add("pmax");
          aliases.add("performance");
        }
        if (normalized === "demand gen") {
          aliases.add("demand generation");
        }
        if (normalized === "se asia") {
          aliases.add("south east asia");
          aliases.add("southeast asia");
        }
        if (normalized === "other" && group.category === "destination") {
          aliases.add("other destination");
        }

        segments.push({
          category: group.category,
          label,
          metrics: row,
          aliases: Array.from(aliases),
        });
      }
    }
  }

  return segments;
}

function slideLooksLikePlaceholder(text: string) {
  return /\bplaceholder|to be confirmed|human review|not provided|missing|supporting data was not provided|attach the relevant export|needs review\b/i.test(
    text,
  );
}

function isSegmentTrendSlide(text: string, title: string) {
  return /\b(monthly|month|trend|by month|mom|time series)\b/i.test(`${title}\n${text}`);
}

function segmentHasTrendData(metrics: Record<string, unknown>) {
  return [
    metrics.monthly,
    metrics.monthly_trends,
    metrics.monthly_trend,
    metrics.trends,
    metrics.trend,
    metrics.time_series,
    metrics.timeseries,
  ].some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return Object.keys(asRecord(value)).length > 0;
  });
}

function shouldPlaceholderSegmentTrendSlide(
  reportData: Record<string, unknown>,
  slideText: string,
  slideTitle: string,
) {
  const segment = slideSegmentForReportData(reportData, slideText, slideTitle);
  return Boolean(
    segment &&
      isSegmentTrendSlide(slideText, slideTitle) &&
      !segmentHasTrendData(segment.metrics),
  );
}

function segmentAliasMatches(input: {
  segment: ReturnType<typeof reportSegments>[number];
  alias: string;
  haystack: string;
}) {
  const { segment, alias, haystack } = input;
  if (!alias) {
    return false;
  }
  if (segment.category === "destination" && alias === "other") {
    return /\bother destination\b/.test(haystack);
  }
  if (segment.category === "campaign" && alias === "other") {
    return (
      !/\bother destination\b/.test(haystack) &&
      !/\bother updates?\b/.test(haystack) &&
      /\bother (?:campaign|summary|trend|monthly|top)\b/.test(haystack)
    );
  }
  if (segment.category === "campaign" && alias === "generic") {
    return /\bgeneric\b/.test(haystack) || /\bgeneric (summary|trend|campaign)\b/.test(haystack);
  }
  if (segment.category === "campaign" && alias === "performance") {
    return /\bperformance max\b/.test(haystack);
  }
  return new RegExp(`(^| )${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(
    haystack,
  );
}

function slideSegmentForReportData(
  reportData: Record<string, unknown>,
  slideText: string,
  slideTitle: string,
) {
  const title = normalizedReportLabel(slideTitle);
  const headingText = normalizedReportLabel(
    [slideTitle, slideText.split(/\n/).slice(0, 5).join(" ")].join(" "),
  );
  if (!headingText) {
    return null;
  }

  const segments = reportSegments(reportData);
  const titleCandidates = segments.filter((segment) =>
    segment.aliases.some((alias) => segmentAliasMatches({ segment, alias, haystack: title })),
  );
  if (titleCandidates.length > 0) {
    return titleCandidates.sort((a, b) => b.label.length - a.label.length).at(0) ?? null;
  }

  const segmentCandidates = segments.filter((segment) =>
    segment.aliases.some((alias) => segmentAliasMatches({ segment, alias, haystack: headingText })),
  );

  return segmentCandidates.sort((a, b) => b.label.length - a.label.length).at(0) ?? null;
}

function reportMetricValuesForSlide(input: {
  reportData: Record<string, unknown>;
  slideText: string;
  slideTitle: string;
  compactCost?: boolean;
}) {
  return reportMetricGroupsForSlide(input)
    .filter((group) => ["leads", "cost", "cpl", "cvr", "clicks", "ctr"].includes(group.key))
    .map((group) => group.replacement)
    .filter(Boolean);
}

function hasUnsupportedComparatorData(reportData: Record<string, unknown>) {
  const missing = reportMissingSections(reportData).join(" ").toLowerCase();
  if (/\byoy|prior[- ]?year|year[- ]on[- ]year|comparator|comparison|trend\b/.test(missing)) {
    return true;
  }
  return (
    Object.keys(asRecord(reportData.yoy)).length === 0 &&
    Object.keys(asRecord(reportData.year_over_year)).length === 0 &&
    Object.keys(asRecord(reportData.comparators)).length === 0
  );
}

function unsupportedComparatorClaim(text: string) {
  return /\b(?:yoy|toy)\b\s*:?\s*[+-]?\d|\byear[- ]on[- ]year\b|\bvs\.?\s+(?:last|prior)\s+year\b|\blast year\b|\bprior year\b|\bmarket conditions\b/i.test(
    text,
  );
}

function malformedPlaceholderText(text: string) {
  return /\bQ[1-4]\s+2[—-]\d{2}\b/.test(text);
}

function containsAnyVariant(text: string, variants: string[]) {
  return variants.some((variant) => variant && text.includes(variant));
}

function metricValuesDiffer(a: number, b: number) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale > 0.02;
}

function segmentMetricIssues(input: {
  reportData: Record<string, unknown>;
  slideText: string;
  slideTitle: string;
}) {
  if (slideLooksLikePlaceholder(input.slideText)) {
    return [];
  }

  const segment = slideSegmentForReportData(input.reportData, input.slideText, input.slideTitle);
  if (!segment) {
    return [];
  }

  if (isSegmentTrendSlide(input.slideText, input.slideTitle) && !segmentHasTrendData(segment.metrics)) {
    return [
      `${segment.category} segment "${segment.label}" trend/monthly slide has no segment-level trend data and must be a placeholder.`,
    ];
  }

  const overallGroups = reportMetricGroupsForRecord(
    reportOverallKpis(input.reportData),
    input.reportData,
    true,
  );
  const segmentGroups = reportMetricGroupsForRecord(segment.metrics, input.reportData, true);
  const segmentMatches = segmentGroups.filter((group) =>
    containsAnyVariant(input.slideText, group.variants),
  );
  const overallLeaks = overallGroups.filter((overall) => {
    const segmentPeer = segmentGroups.find((group) => group.key === overall.key);
    return (
      segmentPeer &&
      metricValuesDiffer(overall.value, segmentPeer.value) &&
      containsAnyVariant(input.slideText, overall.variants) &&
      !containsAnyVariant(input.slideText, segmentPeer.variants)
    );
  });

  const issues: string[] = [];
  if (overallLeaks.length >= 2 && segmentMatches.length < 3) {
    issues.push(
      `${segment.category} segment "${segment.label}" appears to use overall report metrics instead of segment metrics (${overallLeaks
        .map((group) => group.key)
        .join(", ")}).`,
    );
  }

  const mustHave = segmentGroups.filter((group) =>
    ["leads", "cost", "cpl"].includes(group.key),
  );
  const missingCore = mustHave.filter(
    (group) => !containsAnyVariant(input.slideText, group.variants),
  );
  if (missingCore.length >= 2 && !slideLooksLikePlaceholder(input.slideText)) {
    issues.push(
      `${segment.category} segment "${segment.label}" is missing core segment values (${missingCore
        .map((group) => group.key)
        .join(", ")}).`,
    );
  }

  return issues;
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

function genericUpdateTextElementRequests(objectId: string, text: string) {
  return [
    {
      deleteText: {
        objectId,
        textRange: { type: "ALL" },
      },
    },
    {
      insertText: {
        objectId,
        insertionIndex: 0,
        text,
      },
    },
  ];
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

function pushGenericTextElementUpdate(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  objectId: string,
  text: string,
) {
  const trimmedText = text.trim();
  if (!objectId || !trimmedText) {
    return;
  }
  const key = `element\u0000${objectId}\u0000${trimmedText}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  requests.push(...genericUpdateTextElementRequests(objectId, trimmedText));
}

function pushGenericDeleteObjectRequest(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  objectId: string,
) {
  if (!objectId) {
    return;
  }
  const key = `delete\u0000${objectId}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  requests.push({
    deleteObject: {
      objectId,
    },
  });
}

function stableSlidesObjectId(prefix: string, raw: string) {
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 31 + raw.charCodeAt(index)) >>> 0;
  }
  return `${prefix}_${hash.toString(36)}`.slice(0, 48);
}

function pushGenericTextBoxRequest(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  input: {
    slideObjectId: string;
    sourceObjectId: string;
    size: unknown;
    transform: unknown;
    text: string;
  },
) {
  const text = input.text.trim();
  if (!input.slideObjectId || !input.sourceObjectId || !text) {
    return;
  }

  const objectId = stableSlidesObjectId("summon_note", input.sourceObjectId);
  const key = `textbox\u0000${objectId}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  requests.push(
    {
      createShape: {
        objectId,
        shapeType: "TEXT_BOX",
        elementProperties: {
          pageObjectId: input.slideObjectId,
          size: input.size,
          transform: input.transform,
        },
      },
    },
    {
      insertText: {
        objectId,
        insertionIndex: 0,
        text,
      },
    },
  );
}

function elementPropertiesForBox(input: {
  slideObjectId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    pageObjectId: input.slideObjectId,
    size: {
      width: { magnitude: Math.max(1, input.width), unit: "EMU" },
      height: { magnitude: Math.max(1, input.height), unit: "EMU" },
    },
    transform: {
      scaleX: 1,
      scaleY: 1,
      translateX: input.x,
      translateY: input.y,
      unit: "EMU",
    },
  };
}

function pushGenericRectangleRequest(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  input: {
    objectId: string;
    slideObjectId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: { red: number; green: number; blue: number };
  },
) {
  if (seen.has(`shape\u0000${input.objectId}`)) {
    return;
  }
  seen.add(`shape\u0000${input.objectId}`);
  requests.push({
    createShape: {
      objectId: input.objectId,
      shapeType: "RECTANGLE",
      elementProperties: elementPropertiesForBox(input),
    },
  });
  if (input.color) {
    requests.push({
      updateShapeProperties: {
        objectId: input.objectId,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: {
              color: {
                rgbColor: input.color,
              },
            },
          },
        },
        fields: "shapeBackgroundFill.solidFill.color",
      },
    });
  }
}

function pushGenericPositionedTextRequest(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  input: {
    objectId: string;
    slideObjectId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    fontSizePt?: number;
    bold?: boolean;
    color?: { red: number; green: number; blue: number };
  },
) {
  const text = input.text.trim();
  if (!text || seen.has(`shape\u0000${input.objectId}`)) {
    return;
  }
  seen.add(`shape\u0000${input.objectId}`);
  requests.push(
    {
      createShape: {
        objectId: input.objectId,
        shapeType: "TEXT_BOX",
        elementProperties: elementPropertiesForBox(input),
      },
    },
    {
      insertText: {
        objectId: input.objectId,
        insertionIndex: 0,
        text,
      },
    },
  );
  if (input.fontSizePt || typeof input.bold === "boolean" || input.color) {
    requests.push({
      updateTextStyle: {
        objectId: input.objectId,
        style: {
          ...(input.fontSizePt
            ? { fontSize: { magnitude: input.fontSizePt, unit: "PT" } }
            : {}),
          ...(typeof input.bold === "boolean" ? { bold: input.bold } : {}),
          ...(input.color
            ? {
                foregroundColor: {
                  opaqueColor: {
                    rgbColor: input.color,
                  },
                },
              }
            : {}),
        },
        textRange: { type: "ALL" },
        fields: [
          input.fontSizePt ? "fontSize" : "",
          typeof input.bold === "boolean" ? "bold" : "",
          input.color ? "foregroundColor" : "",
        ]
          .filter(Boolean)
          .join(","),
      },
    });
  }
}

function pushGenericPlaceholderTextBoxRequest(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  input: {
    slideObjectId: string;
    sourceObjectId: string;
    text: string;
  },
) {
  const baseId = stableSlidesObjectId("summon_placeholder", input.sourceObjectId);
  const lines = input.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines
    .filter((line) => !/^placeholder\b/i.test(line))
    .join(" ")
    .replace(/^Reason:\s*/i, "")
    .trim();
  const note = reason || "Supporting source data was not provided for this run.";

  pushGenericRectangleRequest(requests, seen, {
    objectId: `${baseId}_bg`.slice(0, 48),
    slideObjectId: input.slideObjectId,
    x: 1_120_000,
    y: 4_185_000,
    width: 6_900_000,
    height: 430_000,
    color: { red: 0.99, green: 0.94, blue: 0.94 },
  });
  pushGenericPositionedTextRequest(requests, seen, {
    objectId: `${baseId}_title`.slice(0, 48),
    slideObjectId: input.slideObjectId,
    x: 1_260_000,
    y: 4_255_000,
    width: 1_250_000,
    height: 150_000,
    text: "Review required",
    fontSizePt: 8,
    bold: true,
    color: { red: 0.62, green: 0.06, blue: 0.1 },
  });
  pushGenericPositionedTextRequest(requests, seen, {
    objectId: `${baseId}_body`.slice(0, 48),
    slideObjectId: input.slideObjectId,
    x: 2_470_000,
    y: 4_250_000,
    width: 5_300_000,
    height: 190_000,
    text: note.length > 155 ? `${note.slice(0, 152).trim()}...` : note,
    fontSizePt: 7,
    color: { red: 0.23, green: 0.23, blue: 0.24 },
  });
}

function isRunGeneratedSlidesElement(objectId: string) {
  return (
    objectId.startsWith("summon_chart_") ||
    objectId.startsWith("summon_note_") ||
    objectId.startsWith("summon_placeholder_")
  );
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

function numericPath(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const segment of path) {
    current = asRecord(current)[segment];
  }
  const number = typeof current === "number" ? current : Number(current);
  return Number.isFinite(number) ? number : undefined;
}

function renderedElementBox(element: Record<string, unknown>) {
  const size = asRecord(element.size);
  const transform = asRecord(element.transform);
  const width = numericPath(size, ["width", "magnitude"]) ?? 0;
  const height = numericPath(size, ["height", "magnitude"]) ?? 0;
  const scaleX = numericPath(transform, ["scaleX"]) ?? 1;
  const scaleY = numericPath(transform, ["scaleY"]) ?? 1;
  const translateX = numericPath(transform, ["translateX"]) ?? 0;
  const translateY = numericPath(transform, ["translateY"]) ?? 0;

  return {
    width: Math.abs(width * scaleX),
    height: Math.abs(height * scaleY),
    translateX,
    translateY,
    area: Math.abs(width * scaleX * height * scaleY),
  };
}

const SLIDE_WIDTH_EMU = 9_144_000;
const SLIDE_HEIGHT_EMU = 5_143_500;
const EMU_PER_INCH = 914_400;
const HEADER_BAND_MAX_Y_EMU = 760_000;
const GENERIC_REPORT_BATCH_REQUEST_LIMIT = 720;

type TextLayoutIssue = {
  objectId: string;
  text: string;
  reason: string;
  box: ReturnType<typeof renderedElementBox>;
};

function textElementBox(element: Record<string, unknown>) {
  const box = renderedElementBox(element);
  if (box.width <= 0 || box.height <= 0) {
    return null;
  }
  return box;
}

function isHeaderOrFooterTextBox(element: Record<string, unknown>) {
  const box = textElementBox(element);
  if (!box) {
    return false;
  }

  return box.translateY < HEADER_BAND_MAX_Y_EMU || box.translateY > SLIDE_HEIGHT_EMU - 760_000;
}

function isHeaderTextBox(element: Record<string, unknown>) {
  const box = textElementBox(element);
  return Boolean(box && box.translateY < HEADER_BAND_MAX_Y_EMU);
}

function estimatedRenderedLineCount(text: string, boxWidthEmu: number) {
  const widthInches = Math.max(0.75, boxWidthEmu / EMU_PER_INCH);
  const charsPerLine = Math.max(12, Math.floor(widthInches * 15));

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce(
      (total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0,
    );
}

function maxReadableLinesForBox(boxHeightEmu: number) {
  const heightInches = Math.max(0.2, boxHeightEmu / EMU_PER_INCH);
  return Math.max(1, Math.floor(heightInches * 5.5));
}

function textLayoutIssueForElement(
  element: Record<string, unknown>,
): TextLayoutIssue | null {
  if (asString(element.source) !== "shape") {
    return null;
  }

  const objectId = asString(element.objectId);
  const text = asString(element.text).trim();
  const box = textElementBox(element);
  if (!objectId || !text || !box) {
    return null;
  }
  if (isRunGeneratedSlidesElement(objectId)) {
    return null;
  }

  const isHeaderBand = box.translateY < HEADER_BAND_MAX_Y_EMU;
  const isTinyTextBox = box.height < 520_000 || box.width < 900_000;
  const estimatedLines = estimatedRenderedLineCount(text, box.width);
  const maxLines = maxReadableLinesForBox(box.height);

  if (box.translateX < -20_000 || box.translateY < -20_000) {
    return {
      objectId,
      text,
      box,
      reason: "Text element starts outside the slide bounds.",
    };
  }

  if (
    box.translateX + box.width > SLIDE_WIDTH_EMU + 20_000 ||
    box.translateY + box.height > SLIDE_HEIGHT_EMU + 20_000
  ) {
    return {
      objectId,
      text,
      box,
      reason: "Text element extends outside the slide bounds.",
    };
  }

  if (isHeaderBand && text.length > 120) {
    return {
      objectId,
      text,
      box,
      reason:
        "Long narrative text is placed in the header/title band and is likely to overflow.",
    };
  }

  if (isTinyTextBox && text.length > 90) {
    return {
      objectId,
      text,
      box,
      reason: "Long text is placed in a small text box and is likely clipped.",
    };
  }

  if (text.length > 120 && estimatedLines > maxLines + 1) {
    return {
      objectId,
      text,
      box,
      reason: `Text likely overflows its box: estimated ${estimatedLines} lines for about ${maxLines} readable lines.`,
    };
  }

  return null;
}

function textLayoutIssuesForSlide(slide: Record<string, unknown>) {
  return asObjectArray(slide.textElements)
    .map(textLayoutIssueForElement)
    .filter((issue): issue is TextLayoutIssue => Boolean(issue));
}

function compactLayoutRepairText(input: {
  reportData: Record<string, unknown>;
  slideText: string;
  slideTitle: string;
  issue: TextLayoutIssue;
}) {
  const segment = slideSegmentForReportData(
    input.reportData,
    input.slideText,
    input.slideTitle,
  );
  const metadata = reportMetadataFromArtifact(input.reportData);
  const isHeaderOrSmallBox =
    input.issue.box.translateY < 1_050_000 ||
    input.issue.box.height < 620_000 ||
    input.issue.box.width < 1_200_000;

  if (isHeaderOrSmallBox) {
    if (segment) {
      return `${segment.label} Performance Summary`;
    }

    const client = metadata.client || "Report";
    const market = metadata.market ? ` ${metadata.market}` : "";
    if (/\boverall|performance|trend|summary|qbr|report\b/i.test(input.slideText)) {
      return `${client}${market} Performance Summary`;
    }

    return input.slideTitle && input.slideTitle.length <= 80
      ? input.slideTitle
      : "Report Summary";
  }

  const commentary = reportDeckCommentaryForSlide({
    reportData: input.reportData,
    slideText: input.slideText,
    slideTitle: input.slideTitle,
  });
  const firstSentence = commentary.split(/\n+/).find(Boolean) ?? commentary;
  return firstSentence.length > 180
    ? `${firstSentence.slice(0, 177).trim()}...`
    : firstSentence;
}

function isLargeCopiedVisualElement(element: Record<string, unknown>) {
  const type = asString(element.type);
  if (!["image", "sheets_chart"].includes(type)) {
    return false;
  }

  const box = renderedElementBox(element);
  const isTopLogoLike = box.translateY < 900_000 && box.height < 900_000;
  if (isTopLogoLike) {
    return false;
  }

  return box.area > 1_750_000_000_000 && box.width > 1_200_000 && box.height > 900_000;
}

function largeCopiedVisualElements(slide: Record<string, unknown>) {
  return asObjectArray(slide.pageElements).filter(isLargeCopiedVisualElement);
}

function monthlyTrendRows(reportData: Record<string, unknown>) {
  const monthly = reportData.monthly_trends ?? reportData.monthly ?? reportData.trends;
  const rows = Object.entries(asRecord(monthly)).map(([period, metrics]) => ({
    period,
    metrics: asRecord(metrics),
  }));
  return rows.sort((a, b) => a.period.localeCompare(b.period));
}

function chartMetricValue(metrics: Record<string, unknown>, metricKey: string) {
  if (metricKey === "cost") {
    return numericMetric(metrics.cost ?? metrics.spend);
  }
  if (metricKey === "leads") {
    return numericMetric(metrics.sales_leads ?? metrics.leads ?? metrics.conversions);
  }
  return numericMetric(metrics[metricKey]);
}

function chartMetricLabel(metricKey: string) {
  if (metricKey === "cost") {
    return "Spend";
  }
  if (metricKey === "cpl") {
    return "CPL";
  }
  if (metricKey === "leads") {
    return "Leads";
  }
  if (metricKey === "ctr") {
    return "CTR";
  }
  if (metricKey === "cvr") {
    return "CVR";
  }
  if (metricKey === "clicks") {
    return "Clicks";
  }
  return metricKey.toUpperCase();
}

function formatChartMetricValue(value: number, metricKey: string, currency: string) {
  if (metricKey === "cost") {
    return formatReportCurrency(value, currency, true);
  }
  if (metricKey === "cpl") {
    return formatReportDecimalCurrency(value, currency);
  }
  if (metricKey === "ctr" || metricKey === "cvr") {
    return formatPercentMetric(value);
  }
  return formatIntegerMetric(value);
}

function formatGeneratedChartMetricLabel(
  value: number,
  metricKey: string,
  currency: string,
) {
  return `${formatChartMetricValue(value, metricKey, currency)} ${chartMetricLabel(metricKey)}`;
}

function metricChartPalette(metricKey: string) {
  if (metricKey === "cost") {
    return {
      fill: { red: 0.1, green: 0.52, blue: 0.34 },
      track: { red: 0.88, green: 0.95, blue: 0.91 },
    };
  }
  if (metricKey === "cpl" || metricKey === "cpc") {
    return {
      fill: { red: 0.85, green: 0.52, blue: 0.12 },
      track: { red: 0.98, green: 0.93, blue: 0.84 },
    };
  }
  if (metricKey === "ctr" || metricKey === "cvr") {
    return {
      fill: { red: 0.32, green: 0.36, blue: 0.82 },
      track: { red: 0.9, green: 0.91, blue: 0.98 },
    };
  }
  return {
    fill: { red: 0.15, green: 0.49, blue: 0.72 },
    track: { red: 0.86, green: 0.93, blue: 0.98 },
  };
}

function chartMetricForVisual(input: {
  visualIndex: number;
  slideText: string;
  slideTitle: string;
}) {
  const haystack = `${input.slideTitle}\n${input.slideText}`.toLowerCase();
  if (/\bcpl\b|cost per lead/.test(haystack)) {
    return input.visualIndex === 0 ? "cpl" : "cost";
  }
  if (/\bctr\b|click through/.test(haystack)) {
    return input.visualIndex === 0 ? "ctr" : "clicks";
  }
  if (/\bconversion|cvr\b/.test(haystack)) {
    return input.visualIndex === 0 ? "cvr" : "leads";
  }
  return ["cost", "cpl", "leads", "ctr"][input.visualIndex % 4];
}

function genericTrendChartRows(
  reportData: Record<string, unknown>,
  metricKey: string,
) {
  return monthlyTrendRows(reportData)
    .map((row) => {
      const value = chartMetricValue(row.metrics, metricKey);
      return typeof value === "number" ? { period: row.period, value } : null;
    })
    .filter((row): row is { period: string; value: number } => Boolean(row));
}

function pushGenericTrendChartRequests(
  requests: Record<string, unknown>[],
  seen: Set<string>,
  input: {
    slideObjectId: string;
    sourceObjectId: string;
    visualIndex: number;
    visual: Record<string, unknown>;
    reportData: Record<string, unknown>;
    slideText: string;
    slideTitle: string;
  },
) {
  const box = renderedElementBox(input.visual);
  const metricKey = chartMetricForVisual({
    visualIndex: input.visualIndex,
    slideText: input.slideText,
    slideTitle: input.slideTitle,
  });
  const rows = genericTrendChartRows(input.reportData, metricKey);
  if (rows.length < 2) {
    pushGenericTextBoxRequest(requests, seen, {
      slideObjectId: input.slideObjectId,
      sourceObjectId: input.sourceObjectId,
      size: input.visual.size,
      transform: input.visual.transform,
      text: visualPlaceholderTextForSlide(input.reportData, input.slideText, input.slideTitle),
    });
    return;
  }

  const metadata = reportMetadataFromArtifact(input.reportData);
  const currency = metadata.currency || "GBP";
  const max = Math.max(...rows.map((row) => row.value), 1);
  const left = box.translateX;
  const top = box.translateY;
  const width = box.width;
  const height = box.height;
  const paddingX = Math.max(90_000, Math.min(180_000, width * 0.055));
  const paddingY = Math.max(70_000, Math.min(140_000, height * 0.055));
  const titleHeight = Math.max(240_000, Math.min(330_000, height * 0.18));
  const labelWidth = Math.max(470_000, Math.min(650_000, width * 0.19));
  const valueWidth = Math.max(560_000, Math.min(850_000, width * 0.22));
  const gutter = Math.max(65_000, Math.min(110_000, width * 0.026));
  const chartLeft = left + paddingX;
  const chartTop = top + paddingY;
  const innerWidth = Math.max(1, width - paddingX * 2);
  const chartWidth = Math.max(520_000, innerWidth - labelWidth - valueWidth - gutter * 2);
  const availableRowHeight = Math.max(
    260_000,
    height - titleHeight - paddingY * 2 - 90_000,
  );
  const rowHeight = Math.max(150_000, availableRowHeight / rows.length);
  const palette = metricChartPalette(metricKey);
  const darkText = { red: 0.11, green: 0.12, blue: 0.13 };
  const mutedText = { red: 0.38, green: 0.4, blue: 0.44 };
  const ruleColor = { red: 0.85, green: 0.86, blue: 0.88 };
  const baseId = stableSlidesObjectId("summon_chart", input.sourceObjectId);

  pushGenericRectangleRequest(requests, seen, {
    objectId: `${baseId}_bg`.slice(0, 48),
    slideObjectId: input.slideObjectId,
    x: left,
    y: top,
    width,
    height,
    color: { red: 0.98, green: 0.985, blue: 0.98 },
  });

  pushGenericPositionedTextRequest(requests, seen, {
    objectId: `${baseId}_title`.slice(0, 48),
    slideObjectId: input.slideObjectId,
    x: chartLeft,
    y: chartTop,
    width: innerWidth,
    height: titleHeight,
    text: `${chartMetricLabel(metricKey)} by month\nGenerated from uploaded data`,
    fontSizePt: 9,
    bold: true,
    color: darkText,
  });

  [0.25, 0.5, 0.75, 1].forEach((ratio, gridIndex) => {
    const x = chartLeft + labelWidth + chartWidth * ratio;
    pushGenericRectangleRequest(requests, seen, {
      objectId: `${baseId}_grid_${gridIndex}`.slice(0, 48),
      slideObjectId: input.slideObjectId,
      x,
      y: chartTop + titleHeight + 20_000,
      width: 6_000,
      height: availableRowHeight + 30_000,
      color: ruleColor,
    });
  });

  rows.forEach((row, index) => {
    const y = chartTop + titleHeight + 35_000 + index * rowHeight;
    const trackHeight = Math.max(45_000, Math.min(76_000, rowHeight * 0.32));
    const barWidth = Math.max(36_000, (row.value / max) * chartWidth);
    const labelId = `${baseId}_l_${index}`.slice(0, 48);
    const trackId = `${baseId}_t_${index}`.slice(0, 48);
    const barId = `${baseId}_b_${index}`.slice(0, 48);
    const valueId = `${baseId}_v_${index}`.slice(0, 48);
    pushGenericPositionedTextRequest(requests, seen, {
      objectId: labelId,
      slideObjectId: input.slideObjectId,
      x: chartLeft,
      y,
      width: labelWidth,
      height: rowHeight * 0.72,
      text: row.period,
      fontSizePt: 8,
      bold: true,
      color: mutedText,
    });
    pushGenericRectangleRequest(requests, seen, {
      objectId: trackId,
      slideObjectId: input.slideObjectId,
      x: chartLeft + labelWidth,
      y: y + rowHeight * 0.22,
      width: chartWidth,
      height: trackHeight,
      color: palette.track,
    });
    pushGenericRectangleRequest(requests, seen, {
      objectId: barId,
      slideObjectId: input.slideObjectId,
      x: chartLeft + labelWidth,
      y: y + rowHeight * 0.22,
      width: barWidth,
      height: trackHeight,
      color: palette.fill,
    });
    pushGenericPositionedTextRequest(requests, seen, {
      objectId: valueId,
      slideObjectId: input.slideObjectId,
      x: chartLeft + labelWidth + chartWidth + gutter,
      y,
      width: valueWidth,
      height: rowHeight * 0.72,
      text: formatGeneratedChartMetricLabel(row.value, metricKey, currency),
      fontSizePt: 8,
      bold: true,
      color: darkText,
    });
  });
}

function visualPlaceholderTextForSlide(
  reportData: Record<string, unknown>,
  slideText: string,
  slideTitle: string,
) {
  const metadata = reportMetadataFromArtifact(reportData);
  const currency = metadata.currency || "GBP";
  const trendRows = monthlyTrendRows(reportData);
  const trendText = trendRows
    .slice(0, 6)
    .map(({ period, metrics }) => {
      const cost = formatReportCurrency(metrics.cost ?? metrics.spend, currency);
      const leads = formatIntegerMetric(metrics.sales_leads ?? metrics.leads);
      const cpl = formatReportDecimalCurrency(metrics.cpl, currency);
      const ctr = formatPercentMetric(metrics.ctr);
      return `${period}: ${[cost, leads ? `${leads} leads` : "", cpl ? `${cpl} CPL` : "", ctr ? `${ctr} CTR` : ""]
        .filter(Boolean)
        .join(", ")}`;
    })
    .filter(Boolean);
  const segment = slideSegmentForReportData(reportData, slideText, slideTitle);
  const segmentText = segment
    ? [
        `${segment.label}:`,
        `Spend ${formatReportCurrency(segment.metrics.cost ?? segment.metrics.spend, currency) || "not found"}`,
        `Leads ${formatIntegerMetric(segment.metrics.sales_leads ?? segment.metrics.leads) || "not found"}`,
        `CPL ${formatReportDecimalCurrency(segment.metrics.cpl, currency) || "not found"}`,
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  return [
    "Chart placeholder - copied template visual removed.",
    trendText.length > 0
      ? `Structured trend data: ${trendText.join(" | ")}`
      : "No chart image was generated for this run.",
    segmentText,
    "Use a chart-generation tool or attach chart assets to replace this placeholder.",
  ]
    .filter(Boolean)
    .join("\n");
}

function metricKeyForLabelText(value: string) {
  const trimmed = value.trim();
  if (
    trimmed.length > 52 ||
    trimmed.includes("\n") ||
    /[.!?]/.test(trimmed) ||
    trimmed.split(/\s+/).length > 5
  ) {
    return "";
  }

  const normalized = normalizedReportLabel(value);
  if (!normalized) {
    return "";
  }
  if (/\bcvr\b|\bconversion rate\b/.test(normalized)) {
    return "cvr";
  }
  if (/\bctr\b|\bclick through rate\b/.test(normalized)) {
    return "ctr";
  }
  if (/\bcpl\b|\bcost per lead\b/.test(normalized)) {
    return "cpl";
  }
  if (/\bcpc\b|\bcost per click\b/.test(normalized)) {
    return "cpc";
  }
  if (/\bclicks?\b/.test(normalized)) {
    return "clicks";
  }
  if (/\bimpressions?\b/.test(normalized)) {
    return "impressions";
  }
  if (/\b(leads?|conversions?)\b/.test(normalized)) {
    return "leads";
  }
  if (/\b(spend|cost|media spend)\b/.test(normalized)) {
    return "cost";
  }
  return "";
}

function slideShapeTextElements(slide: Record<string, unknown>) {
  return asObjectArray(slide.textElements)
    .map((element, index) => ({
      index,
      objectId: asString(element.objectId),
      source: asString(element.source),
      text: asString(element.text),
    }))
    .filter((element) => element.source === "shape" && element.objectId && element.text.trim());
}

function nearestMetricTextElement(
  elements: ReturnType<typeof slideShapeTextElements>,
  labelIndex: number,
) {
  const previous = elements
    .slice(0, labelIndex)
    .reverse()
    .find((element) => isLikelyMetricText(element.text));
  if (previous) {
    return previous;
  }
  return elements
    .slice(labelIndex + 1)
    .find((element) => isLikelyMetricText(element.text));
}

function reportMetricGroupsForSlide(input: {
  reportData: Record<string, unknown>;
  slideText: string;
  slideTitle: string;
  compactCost?: boolean;
}) {
  const segment = slideSegmentForReportData(input.reportData, input.slideText, input.slideTitle);
  const record = segment ? segment.metrics : reportOverallKpis(input.reportData);
  return reportMetricGroupsForRecord(
    record,
    input.reportData,
    Boolean(input.compactCost),
  ).filter((group) =>
    ["leads", "cost", "cpl", "cvr", "clicks", "ctr", "impressions", "cpc"].includes(group.key),
  );
}

function metricLabelValueIssues(input: {
  reportData: Record<string, unknown>;
  slide: Record<string, unknown>;
  slideText: string;
  slideTitle: string;
}) {
  if (slideLooksLikePlaceholder(input.slideText)) {
    return [];
  }

  const metricGroups = new Map(
    reportMetricGroupsForSlide({
      reportData: input.reportData,
      slideText: input.slideText,
      slideTitle: input.slideTitle,
      compactCost: true,
    }).map((group) => [group.key, group]),
  );
  if (metricGroups.size === 0) {
    return [];
  }

  const elements = slideShapeTextElements(input.slide);
  const issues: string[] = [];
  for (const [elementIndex, element] of elements.entries()) {
    const key = metricKeyForLabelText(element.text);
    const expected = key ? metricGroups.get(key) : undefined;
    if (!expected) {
      continue;
    }
    const metricElement = nearestMetricTextElement(elements, elementIndex);
    if (!metricElement) {
      continue;
    }
    if (!containsAnyVariant(metricElement.text, expected.variants)) {
      issues.push(
        `KPI metric label "${element.text.trim()}" is paired with "${metricElement.text.trim()}" instead of ${expected.replacement}.`,
      );
    }
  }

  return issues;
}

function generatedChartMetricIssues(input: {
  reportData: Record<string, unknown>;
  slideText: string;
}) {
  if (!/generated from uploaded data/i.test(input.slideText)) {
    return [];
  }

  const metadata = reportMetadataFromArtifact(input.reportData);
  const currency = metadata.currency || "GBP";
  const issues: string[] = [];
  const chartKeys = [
    ["cost", "Spend"],
    ["cpl", "CPL"],
    ["leads", "Leads"],
    ["ctr", "CTR"],
    ["cvr", "CVR"],
    ["clicks", "Clicks"],
  ] as const;

  for (const [metricKey, label] of chartKeys) {
    const chartTitlePattern = new RegExp(
      `(?:${label}\\s+by month|Monthly\\s+${label})\\s+(?:- |\\()?generated from uploaded data`,
      "i",
    );
    if (!chartTitlePattern.test(input.slideText)) {
      continue;
    }

    const expectedRows = genericTrendChartRows(input.reportData, metricKey);
    if (expectedRows.length < 2) {
      continue;
    }

    const missing = expectedRows.filter((row) => {
      const valueLabel = formatGeneratedChartMetricLabel(row.value, metricKey, currency);
      return !input.slideText.includes(row.period) || !input.slideText.includes(valueLabel);
    });

    if (missing.length > 0) {
      issues.push(
        `${label} generated chart is missing or has incorrect monthly values for ${missing
          .map((row) => row.period)
          .join(", ")}.`,
      );
    }
  }

  return issues;
}

function reportDeckCommentary(reportData: Record<string, unknown>) {
  const overall = reportOverallKpis(reportData);
  return reportDeckCommentaryForRecord({
    reportData,
    record: overall,
    label: "",
  });
}

function reportDeckCommentaryForRecord(input: {
  reportData: Record<string, unknown>;
  record: Record<string, unknown>;
  label?: string;
}) {
  const metadata = reportMetadataFromArtifact(input.reportData);
  const record = input.record;
  const currency = metadata.currency || "GBP";
  const client = metadata.client || "the client";
  const market = metadata.market ? `${metadata.market} ` : "";
  const period = metadata.period ? ` for ${metadata.period}` : "";
  const label = input.label ? `${input.label} ` : "";
  const leads = formatIntegerMetric(record.sales_leads ?? record.leads) || "unverified";
  const spend = formatReportCurrency(record.cost ?? record.spend, currency) || "unverified";
  const cpl = formatReportDecimalCurrency(record.cpl, currency) || "unverified";
  const cvr = formatPercentMetric(record.cvr) || "unverified";
  const clicks = formatIntegerMetric(record.clicks) || "unverified";
  const ctr = formatPercentMetric(record.ctr) || "unverified";

  return [
    `${client} ${market}${label}performance${period} was rebuilt from the uploaded report data, not copied from the visual template.`,
    `The data shows ${leads} leads from ${spend} spend, with ${clicks} clicks, ${ctr} CTR, ${cpl} CPL, and ${cvr} CVR.`,
    hasUnsupportedComparatorData(input.reportData)
      ? "Comparator, prior-year, or YoY claims were not supported by the uploaded data and should stay out of this slide until supporting evidence is attached."
      : "Slides with missing planning, auction, or update data should remain as human-editable placeholders until supporting evidence is attached.",
  ].join("\n");
}

function reportDeckCommentaryForSlide(input: {
  reportData: Record<string, unknown>;
  slideText: string;
  slideTitle: string;
}) {
  const segment = slideSegmentForReportData(input.reportData, input.slideText, input.slideTitle);
  if (!segment) {
    return reportDeckCommentary(input.reportData);
  }

  return reportDeckCommentaryForRecord({
    reportData: input.reportData,
    record: segment.metrics,
    label: segment.label,
  });
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

function compactPlaceholderReason(input: {
  reportData: Record<string, unknown>;
  slideText: string;
  auditReasons?: string[];
}) {
  const auditText = (input.auditReasons ?? []).join(" ").toLowerCase();
  if (auditText.includes("no segment-level trend data")) {
    return "Segment-level trend data is not available in the uploaded file.";
  }
  if (auditText.includes("missing core segment values")) {
    return "Required segment KPI values are not available in the uploaded file.";
  }
  if (auditText.includes("overall report metrics")) {
    return "Only overall data was available; this slide needs segment-specific data.";
  }
  if (auditText.includes("header/title band") || auditText.includes("overflows")) {
    return "This template section needs supporting planning or commentary input.";
  }
  if (auditText.includes("stale")) {
    return "Source-template content could not be verified for this run.";
  }

  const reason = placeholderReason(input.reportData, input.slideText)
    .replace(/\s+/g, " ")
    .trim();
  if (!reason) {
    return "Supporting data was not provided for this run.";
  }
  if (/auction/i.test(reason)) {
    return "Auction-insight export was not provided.";
  }
  if (/yoy|prior-year|prior year|comparison/i.test(reason)) {
    return "Prior-year comparison data was not provided.";
  }
  if (/plans|next steps|client updates|human-provided context/i.test(reason)) {
    return "Planning notes or client-update context was not provided.";
  }

  return reason.length > 120 ? `${reason.slice(0, 117).trim()}...` : reason;
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

function placeholderTextForSlide(
  reportData: Record<string, unknown>,
  slideText: string,
  auditReasons: string[] = [],
) {
  const reason = compactPlaceholderReason({ reportData, slideText, auditReasons });
  return [
    "Placeholder - source data not provided.",
    reason ? `Reason: ${reason}` : "",
    "Attach the missing export or context and rerun.",
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldPreservePlaceholderElement(
  text: string,
  slideTitle: string,
  staleTerms: string[] = [],
) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (staleTerms.some((term) => staleTermMatches(text, term))) {
    return false;
  }
  if (isLikelyMetricText(text)) {
    return false;
  }
  if (slideLooksLikePlaceholder(text)) {
    return false;
  }
  if (malformedPlaceholderText(text)) {
    return false;
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

function tableCellsForSlide(slide: Record<string, unknown>) {
  return asObjectArray(slide.pageElements).flatMap((element) => {
    const table = asRecord(element.table);
    return asObjectArray(table.cells).map((cell) => asString(cell.text));
  });
}

function hasSubstantiveTableContent(slide: Record<string, unknown>) {
  return tableCellsForSlide(slide).some((text) => {
    const normalized = text.trim();
    return Boolean(
      normalized &&
        normalized !== "—" &&
        !slideLooksLikePlaceholder(normalized) &&
        !/^q[1-4]\s+\d{4}/i.test(normalized) &&
        !/summon digital|confidential|prepared by summon/i.test(normalized),
    );
  });
}

function genericReportDeckBatchRequests(results: unknown[]) {
  const reportData = metricArtifactJson(results);
  const metadata = reportMetadataFromArtifact(reportData);
  const deckMap = latestDeckMap(results);
  const auditIssuesBySlide = latestDeckAuditBlockingIssues(results);
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
    const pageElements = asObjectArray(slide.pageElements);
    const slideText = textElements.map((element) => asString(element.text)).join(" ");
    const slideTitle = asString(slide.titleCandidate);
    const auditIssue = auditIssuesBySlide.get(slideObjectId);
    const auditReasons = auditIssue?.reasons ?? [];
    const auditRequiresPlaceholder = auditIssueRequiresPlaceholder(auditReasons);
    const containsStaleTerm = staleTerms.some((term) => staleTermMatches(slideText, term));
    const containsExpectedValue = expectedReportValues(reportData).some((value) =>
      slideText.includes(value),
    );
    const containsUnsupportedComparator =
      hasUnsupportedComparatorData(reportData) && unsupportedComparatorClaim(slideText);
    const placeholderWithCopiedTableContent =
      slideLooksLikePlaceholder(slideText) && hasSubstantiveTableContent(slide);
    const layoutIssues = textLayoutIssuesForSlide(slide);
    const copiedVisuals = largeCopiedVisualElements(slide);
    const values = reportMetricValuesForSlide({
      reportData,
      slideText,
      slideTitle,
      compactCost: true,
    });
    const commentary = reportDeckCommentaryForSlide({
      reportData,
      slideText,
      slideTitle,
    });

    if (
      auditRequiresPlaceholder ||
      shouldPlaceholderReportSlide(reportData, slideText) ||
      shouldPlaceholderSegmentTrendSlide(reportData, slideText, slideTitle) ||
      placeholderWithCopiedTableContent ||
      malformedPlaceholderText(slideText) ||
      (containsStaleTerm && !containsExpectedValue && !/summary|overview|performance report|qbr/i.test(slideText))
    ) {
      const placeholderText = placeholderTextForSlide(reportData, slideText, auditReasons);
      textElements
        .filter((element) => asString(element.source) === "shape")
        .map((element) => ({
          objectId: asString(element.objectId),
          text: asString(element.text),
          size: element.size,
          transform: element.transform,
        }))
        .filter(
          (element) =>
            element.objectId &&
            !isRunGeneratedSlidesElement(element.objectId) &&
            isHeaderTextBox(asRecord(element)) &&
            slideLooksLikePlaceholder(element.text),
        )
        .forEach((element) => {
          pushGenericTextElementUpdate(
            placeholderRequests,
            seen,
            element.objectId,
            "Review required",
          );
        });
      const shapeElements = textElements
        .filter((element) => asString(element.source) === "shape")
        .map((element) => ({
          objectId: asString(element.objectId),
          text: asString(element.text),
          size: element.size,
          transform: element.transform,
        }))
        .filter(
          (element) =>
            element.objectId &&
            !isRunGeneratedSlidesElement(element.objectId) &&
            !(
              isHeaderOrFooterTextBox(asRecord(element)) &&
              shouldPreservePlaceholderElement(element.text, slideTitle, staleTerms)
            ) &&
            element.text.trim().length > 0 &&
            element.text.trim() !== "—",
        );
      const placeholderElements = shapeElements
        .filter((element) => !shouldPreservePlaceholderElement(element.text, slideTitle, staleTerms))
        .sort((a, b) => b.text.length - a.text.length);
      const placeholderTargets =
        placeholderElements.length > 0
          ? placeholderElements
          : shapeElements.filter(
              (element) =>
                !/summon digital|confidential|prepared by summon|wendy wu tours \|/i.test(element.text),
            );

      placeholderTargets.slice(0, 80).forEach((element) => {
        pushGenericTextElementUpdate(
          placeholderRequests,
          seen,
          element.objectId,
          "—",
        );
      });
      pageElements
        .filter((element) => {
          const objectId = asString(element.objectId);
          return (
            ["table", "sheets_chart"].includes(asString(element.type)) ||
            isLargeCopiedVisualElement(element) ||
            isRunGeneratedSlidesElement(objectId)
          );
        })
        .map((element) => asString(element.objectId))
        .filter(Boolean)
        .forEach((objectId) => {
          pushGenericDeleteObjectRequest(placeholderRequests, seen, objectId);
        });
      pushGenericPlaceholderTextBoxRequest(placeholderRequests, seen, {
        slideObjectId,
        sourceObjectId: `${slideObjectId}_placeholder`,
        text: placeholderText,
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

    layoutIssues.forEach((issue) => {
      pushGenericTextElementUpdate(
        updateRequests,
        seen,
        issue.objectId,
        compactLayoutRepairText({
          reportData,
          slideText,
          slideTitle,
          issue,
        }),
      );
    });

    if (containsUnsupportedComparator) {
      textElements
        .map((element) => asString(element.text))
        .filter((text) => unsupportedComparatorClaim(text))
        .forEach((text) => {
          pushGenericSlideReplacement(
            updateRequests,
            seen,
            slideObjectId,
            text,
            "Comparator data was not provided for this run.",
          );
        });
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

    const metricGroupsByKey = new Map(
      reportMetricGroupsForSlide({
        reportData,
        slideText,
        slideTitle,
        compactCost: true,
      }).map((group) => [group.key, group]),
    );
    const labelAwareMetricTargets = slideShapeTextElements(slide)
      .map((element, elementIndex, elements) => {
        const key = metricKeyForLabelText(element.text);
        const group = key ? metricGroupsByKey.get(key) : undefined;
        const metricElement = group ? nearestMetricTextElement(elements, elementIndex) : undefined;
        return group && metricElement
          ? {
              objectId: metricElement.objectId,
              replacement: group.replacement,
            }
          : null;
      })
      .filter(Boolean);
    const labelAwareObjectIds = new Set<string>();
    for (const target of labelAwareMetricTargets) {
      if (!target || labelAwareObjectIds.has(target.objectId)) {
        continue;
      }
      labelAwareObjectIds.add(target.objectId);
      pushGenericTextElementUpdate(
        updateRequests,
        seen,
        target.objectId,
        target.replacement,
      );
    }

    const metricElements = textElements
      .filter((element) => asString(element.source) !== "table_cell")
      .map((element) => ({
        objectId: asString(element.objectId),
        text: asString(element.text),
      }))
      .filter(
        (element) =>
          !labelAwareObjectIds.has(element.objectId) &&
          isLikelyMetricText(element.text) &&
          !/^(?:[A-Z]{0,3}\$|£|\$|€)$/i.test(element.text.trim()),
      )
      .map((element) => element.text);
    metricElements.slice(0, values.length).forEach((find, index) => {
      const replace = values[index];
      if (replace) {
        pushGenericSlideReplacement(updateRequests, seen, slideObjectId, find, replace);
      }
    });

    const longTextElement = textElements
      .filter((element) => asString(element.source) === "shape")
      .map((element) => ({
        objectId: asString(element.objectId),
        text: asString(element.text),
        size: element.size,
        transform: element.transform,
      }))
      .filter((element) => {
        if (!element.objectId || element.text.length <= 140) {
          return false;
        }
        const box = textElementBox(asRecord(element));
        return Boolean(
          box &&
            box.translateY >= 1_050_000 &&
            box.height >= 900_000 &&
            box.width >= 1_400_000,
        );
      })
      .at(-1);
    if (
      longTextElement &&
      (/\b(uk|united kingdom|£|summary|performance|trend)\b/i.test(longTextElement.text) ||
        containsUnsupportedComparator ||
        slideSegmentForReportData(reportData, slideText, slideTitle))
    ) {
      pushGenericTextElementUpdate(updateRequests, seen, longTextElement.objectId, commentary);
    }

    const segment = slideSegmentForReportData(reportData, slideText, slideTitle);
    const missingSegmentCore = segmentMetricIssues({ reportData, slideText, slideTitle }).some((issue) =>
      issue.includes("missing core segment values"),
    );
    if (segment && missingSegmentCore && !isSegmentTrendSlide(slideText, slideTitle)) {
      const shapeElements = textElements
        .filter((element) => asString(element.source) === "shape")
        .map((element) => ({
          objectId: asString(element.objectId),
          text: asString(element.text),
          size: element.size,
          transform: element.transform,
        }))
        .filter((element) => element.objectId && element.text.trim().length > 0 && element.text.trim() !== "—");
      const fallbackElement = shapeElements
        .filter((element) => {
          if (shouldPreservePlaceholderElement(element.text, slideTitle)) {
            return false;
          }
          const box = textElementBox(asRecord(element));
          return Boolean(
            box &&
              box.translateY >= 1_050_000 &&
              box.height >= 900_000 &&
              box.width >= 1_400_000,
          );
        })
        .sort((a, b) => b.text.length - a.text.length)
        .at(0) ??
        shapeElements
          .filter(
            (element) => {
              if (
                /summon digital|confidential|prepared by summon|wendy wu tours \|/i.test(
                  element.text,
                )
              ) {
                return false;
              }
              const box = textElementBox(asRecord(element));
              return Boolean(
                box &&
                  box.translateY >= 1_050_000 &&
                  box.height >= 900_000 &&
                  box.width >= 1_400_000,
              );
            },
          )
        .at(0);
      if (fallbackElement) {
        pushGenericTextElementUpdate(updateRequests, seen, fallbackElement.objectId, commentary);
      }
    }

    for (const term of currencyStaleTerms) {
      const replacement = currencyPrefix(metadata.currency);
      if (replacement) {
        pushGenericSlideReplacement(updateRequests, seen, slideObjectId, term, replacement);
      }
    }

    for (const [visualIndex, visual] of copiedVisuals
      .slice()
      .sort(
        (a, b) =>
          renderedElementBox(a).translateX - renderedElementBox(b).translateX,
      )
      .entries()) {
      const objectId = asString(visual.objectId);
      pushGenericDeleteObjectRequest(updateRequests, seen, objectId);
      pushGenericTrendChartRequests(updateRequests, seen, {
        slideObjectId,
        sourceObjectId: objectId,
        visualIndex,
        visual,
        reportData,
        slideText,
        slideTitle,
      });
    }
  }

  return [...placeholderRequests, ...updateRequests].slice(
    0,
    GENERIC_REPORT_BATCH_REQUEST_LIMIT,
  );
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
    terms.push("Wendy Wu Tours UK", "WWT UK", "United Kingdom", " UK ", ".co.uk");
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
    const title = asString(slide.titleCandidate);
    const reasons: string[] = [];
    if (staleTerms.some((term) => staleTermMatches(text, term))) {
      reasons.push("Contains stale source-market or source-template text.");
    }
    reasons.push(
      ...segmentMetricIssues({
        reportData: input.reportData,
        slideText: text,
        slideTitle: title,
      }),
    );
    reasons.push(
      ...metricLabelValueIssues({
        reportData: input.reportData,
        slide,
        slideText: text,
        slideTitle: title,
      }),
    );
    reasons.push(
      ...generatedChartMetricIssues({
        reportData: input.reportData,
        slideText: text,
      }),
    );
    reasons.push(
      ...textLayoutIssuesForSlide(slide).map((issue) => issue.reason),
    );
    if (
      hasUnsupportedComparatorData(input.reportData) &&
      unsupportedComparatorClaim(text) &&
      !slideLooksLikePlaceholder(text)
    ) {
      reasons.push("Contains unsupported YoY, prior-year, or comparator commentary.");
    }
    if (malformedPlaceholderText(text)) {
      reasons.push("Contains malformed copied template placeholder/date text.");
    }
    if (slideLooksLikePlaceholder(text)) {
      reasons.push("Marked as placeholder or human-review content.");
      if (hasSubstantiveTableContent(slide)) {
        reasons.push("placeholder slide still contains substantive copied table content.");
      }
      if (largeCopiedVisualElements(slide).length > 0) {
        reasons.push("placeholder slide still contains substantive copied visual/chart content.");
      }
    } else {
      const copiedVisuals = largeCopiedVisualElements(slide);
      if (copiedVisuals.length > 0 && asString(slide.classification) !== "section_divider") {
        reasons.push(
          `Contains ${copiedVisuals.length} unverified copied chart/image visual block${
            copiedVisuals.length === 1 ? "" : "s"
          } from the source template.`,
        );
      }
    }

    const hasBlockingReason = reasons.some(
      (reason) => {
        const normalizedReason = reason.toLowerCase();
        return (
          normalizedReason.includes("stale") ||
          normalizedReason.includes("segment") ||
          normalizedReason.includes("unsupported") ||
          normalizedReason.includes("malformed") ||
          normalizedReason.includes("copied table content") ||
          normalizedReason.includes("copied visual") ||
          normalizedReason.includes("copied chart") ||
          normalizedReason.includes("unverified copied chart") ||
          normalizedReason.includes("unverified copied image") ||
          normalizedReason.includes("generated chart") ||
          normalizedReason.includes("monthly values") ||
          normalizedReason.includes("layout") ||
          normalizedReason.includes("overflow") ||
          normalizedReason.includes("outside the slide") ||
          normalizedReason.includes("likely clipped") ||
          normalizedReason.includes("small text box") ||
          normalizedReason.includes("header/title band") ||
          normalizedReason.includes("kpi") ||
          normalizedReason.includes("metric")
        );
      },
    );
    const status = hasBlockingReason
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
  const blockingSlideIssues = slideStatuses
    .filter((slide) => asString(slide.status) === "needs-human-review")
    .map((slide) => ({
      slideIndex: slide.slideIndex,
      slideObjectId: slide.slideObjectId,
      reasons: slide.reasons,
    }));
  const score = Math.max(
    0,
    100 -
      staleReferences.length * 10 -
      missingExpectedValues.length * 4 -
      blockingSlideIssues.length * 12,
  );
  const recommendations = [
    staleReferences.length > 0
      ? "Replace stale source-market references or explicitly mark those slides as placeholders."
      : "",
    missingExpectedValues.length > 0
      ? "Add missing calculated KPI values from report_data.json to the deck or explain why they are not applicable."
      : "",
    blockingSlideIssues.length > 0
      ? "Fix slides marked needs-human-review: use segment-level report_data values, remove unsupported YoY/comparator claims, remove stale copied visual/chart evidence, or convert unsupported slides to placeholders."
      : "",
    "Use deck-map element IDs for slide-scoped edits instead of broad global text replacement.",
  ].filter(Boolean);

  return {
    presentationId: input.presentationId,
    title: deckMap.title,
    targetClient,
    targetMarket,
    expectedCurrency,
    passed:
      staleReferences.length === 0 &&
      missingExpectedValues.length <= 1 &&
      blockingSlideIssues.length === 0,
    score,
    staleReferences,
    missingExpectedValues,
    blockingSlideIssues,
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

function generatedOutputLines(results: unknown[]) {
  const lines: string[] = [];

  for (const result of successfulToolResults(results)) {
    for (const artifact of asObjectArray(result.artifacts)) {
      const name = asString(artifact.name, "Generated artifact");
      const location = asString(artifact.location);
      const type = asString(artifact.type, asString(artifact.artifactType, "artifact"));
      lines.push(location ? `- ${name} (${type}): ${location}` : `- ${name} (${type})`);
    }

    const payload = asRecord(result.result);
    const pageUrl = asString(payload.pageUrl);
    if (result.toolName === "notion.createPage" && pageUrl) {
      lines.push(`- Notion memory page: ${pageUrl}`);
    }

    const webViewLink = asString(payload.webViewLink);
    const fileName = asString(payload.fileName);
    if (webViewLink && fileName) {
      lines.push(`- ${fileName}: ${webViewLink}`);
    }
  }

  return Array.from(new Set(lines));
}

function deterministicSummaryMarkdown(input: {
  agentName: string;
  results: unknown[];
}) {
  const metrics = metricArtifactJson(input.results);
  const hasMetrics = Object.keys(metrics).length > 0;
  const metadata = reportMetadataFromArtifact(metrics);
  const overall = reportOverallKpis(metrics);
  const lines = [
    `# ${input.agentName} output`,
    "",
    "Generated by the Summon generic tool runtime.",
    "",
    "## Generated outputs",
    ...(generatedOutputLines(input.results).length > 0
      ? generatedOutputLines(input.results)
      : ["- No generated output links recorded."]),
    ...(hasMetrics
      ? [
          "",
          "## Metrics calculated from sandbox output",
          `- Leads: ${formatIntegerMetric(overall.sales_leads) || "not found"}`,
          `- Spend: ${
            formatReportCurrency(overall.cost, metadata.currency || "GBP") || "not found"
          }`,
          `- CPL: ${
            formatReportDecimalCurrency(overall.cpl, metadata.currency || "GBP") ||
            "not found"
          }`,
          `- CVR: ${formatPercentMetric(overall.cvr) || "not found"}`,
          `- CTR: ${formatPercentMetric(overall.ctr) || "not found"}`,
        ]
      : []),
    "",
    "## Tool status",
    ...input.results.filter(isToolCallOutputRecord).map((result) => {
      const suffix = result.error ? ` (${result.error})` : "";
      return `- ${result.toolName}: ${result.status}${suffix}`;
    }),
    "",
    "## Caveats",
    "- This summary is generated from tool outputs and uploaded/sandbox data.",
    "- Human review is still required before using generated outputs externally.",
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
  return normalizeAgentToolSelection(selectedTools).filter(isGenericAgentToolKey);
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
    case "google.drive.uploadArtifact":
      return {
        artifactName:
          "sandbox generated file name or artifact://relative/path.png from a prior python.run",
        artifactId: "optional sandbox artifact id from a prior python.run",
        name: "optional output file name in Drive",
        mimeType: "optional MIME type, inferred from file extension when omitted",
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
    case "google.sheets.createSpreadsheet":
      return {
        title: "new Google Sheet title",
        sheetTitle: "optional first tab name",
        range: "optional starting A1 range when seeding rows, e.g. Sheet1!A1",
        rows: "optional 2D array of rows/cells to seed into the new Sheet",
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
    "For spreadsheet/table outputs, use google.sheets.createSpreadsheet to create a run-owned native Google Sheet, seed rows when available, then use google.sheets.updateRange/readRange for follow-up edits and verification.",
    "For Google Slides template work, use google.slides.inspectTemplate on the copied deck before editing so you can target slide IDs, element IDs, table cells, images/charts, and placeholder candidates.",
    "Prefer google.slides.updateText and google.slides.updateTableCell for precise slide-scoped edits. Use google.slides.batchUpdate for duplicated slides, new shapes, layout changes, and chart/image placeholder areas.",
    "When Python creates chart/image files such as PNG, JPG, WebP, GIF, or SVG, upload them with google.drive.uploadArtifact. Then insert them into copied Slides with google.slides.batchUpdate createImage using the upload result downloadUrl, or reference the generated file as artifact://relative/path.png inside the batchUpdate request.",
    "Do not treat a visual template as trusted content. Replace stale source-market labels, copied commentary, and old KPI claims, or explicitly mark the slide as a human-editable placeholder.",
    "Python/report agents should produce a structured report_data.json artifact where possible: metadata, overall_kpis, trends, segment breakdowns, missing sections, and placeholder recommendations.",
    "For report decks, run google.slides.auditDeck after writing the copied deck. If it flags stale source-market text or missing KPI values, fix the deck and audit again.",
    "For google.slides.replaceText, match exact visible text inside a single text run. If a KPI value and label are separate, replace the standalone value, for example \"5,682\" instead of \"5,682 Total Leads\".",
    "After google.slides.replaceText, inspect replacementResults. If a required replacement has occurrencesChanged: 0, issue another replaceText with a narrower exact text or use batchUpdate against the copied deck.",
    "If the run prompt requires a generated deck, report, file, or memory page, keep calling tools until those artifacts are actually created or updated. Do not finalize from a copied/read-only artifact.",
    "If Required workflow outcomes below is non-empty, you must call tools to complete at least one missing outcome. Only return {\"toolCalls\":[]} when the missing outcomes are resolved or a tool failure makes them impossible.",
    "For Python work, use uploaded helper files or provide short generated Python in python.run.code.",
    "When referencing a prior tool result, copy the concrete ID or URL from Prior tool results. Do not emit template placeholders like {{toolCalls[0].output.fileId}}.",
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
    "Compact connector evidence for generated content:",
    compactConnectorEvidenceForFinalPrompt(input.basePrompt),
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
    "Connector evidence for final answer:",
    compactConnectorEvidenceForFinalPrompt(input.basePrompt),
    "",
    "Tool execution results:",
    JSON.stringify(compactToolResultsForPrompt(input.toolResults), null, 2),
    "",
    "Write the final response for the Summon team.",
    "Include evidence used, generated artifacts with links, what was not verified, recommendations, and any blocked protected actions.",
    "If connector evidence records are listed above, cite their source titles and URLs when relevant. Do not say no connector evidence was supplied unless the connector evidence section is empty or contains only blockers.",
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

function mimeTypeForArtifactName(name: string) {
  const extension = path.extname(name).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function normalizeArtifactRef(value: string) {
  return value.replace(/^artifact:\/\//i, "").replace(/^sandbox:\/\//i, "").trim();
}

async function findSandboxArtifact(input: {
  agentRunId: string;
  artifactId?: string;
  artifactName?: string;
}) {
  const db = getDb();
  const artifactId = input.artifactId?.trim();
  const artifactName = input.artifactName ? normalizeArtifactRef(input.artifactName) : "";
  if (!artifactId && !artifactName) {
    throw new Error("A sandbox artifact id or name is required.");
  }
  const artifact = artifactId
    ? await db.agentArtifact.findFirst({
        where: {
          id: artifactId,
          agentRunId: input.agentRunId,
          artifactType: "sandbox_file",
        },
      })
    : await db.agentArtifact.findFirst({
        where: {
          agentRunId: input.agentRunId,
          artifactType: "sandbox_file",
          OR: [
            { name: artifactName },
            { name: { endsWith: `/${artifactName}` } },
          ],
        },
        orderBy: { createdAt: "desc" },
      });

  if (!artifact?.location) {
    throw new Error(
      `Sandbox artifact not found for this run: ${artifactId || artifactName || "missing artifact reference"}.`,
    );
  }

  const safeRoot = path.resolve(os.tmpdir(), "summon-agent-runs", input.agentRunId);
  const resolvedLocation = path.resolve(artifact.location);
  if (
    resolvedLocation !== safeRoot &&
    !resolvedLocation.startsWith(`${safeRoot}${path.sep}`)
  ) {
    throw new Error("Sandbox artifact path is outside this run workspace.");
  }

  return {
    id: artifact.id,
    name: artifact.name,
    location: resolvedLocation,
    mimeType: artifact.mimeType,
  };
}

async function uploadSandboxArtifactToDrive(input: {
  agentRunId: string;
  toolCallId: string;
  workspaceId: string;
  state: RuntimeState;
  artifactId?: string;
  artifactName?: string;
  outputName?: string;
  mimeType?: string;
}) {
  const source = await findSandboxArtifact({
    agentRunId: input.agentRunId,
    artifactId: input.artifactId,
    artifactName: input.artifactName,
  });
  const content = await readFile(source.location);
  const outputName = input.outputName?.trim() || path.basename(source.name);
  const mimeType =
    input.mimeType?.trim() ||
    (source.mimeType && source.mimeType !== "text/plain" ? source.mimeType : "") ||
    mimeTypeForArtifactName(outputName || source.name);
  const uploaded = await createGoogleDriveBinaryFile({
    workspaceId: input.workspaceId,
    name: outputName,
    content,
    mimeType,
    makePublic: true,
  });

  input.state.createdGoogleFileIds.add(uploaded.fileId);
  input.state.createdGoogleFiles.push(uploaded);

  const artifact = artifactOutput(
    await createArtifact({
      agentRunId: input.agentRunId,
      toolCallId: input.toolCallId,
      artifactType: "google_drive_file",
      name: uploaded.fileName,
      location: uploaded.webViewLink ?? uploaded.downloadUrl,
      mimeType: uploaded.mimeType,
      payload: {
        ...uploaded,
        sourceArtifactId: source.id,
        sourceArtifactName: source.name,
      },
    }),
  );

  return {
    uploaded,
    artifact,
  };
}

function replaceArtifactRefsDeep(
  value: unknown,
  resolver: (artifactName: string) => string | null,
): unknown {
  if (typeof value === "string") {
    const normalized = normalizeArtifactRef(value);
    return value.startsWith("artifact://") || value.startsWith("sandbox://")
      ? resolver(normalized) ?? value
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceArtifactRefsDeep(item, resolver));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        replaceArtifactRefsDeep(child, resolver),
      ]),
    );
  }

  return value;
}

function collectArtifactRefs(value: unknown, refs = new Set<string>()) {
  if (typeof value === "string") {
    if (value.startsWith("artifact://") || value.startsWith("sandbox://")) {
      refs.add(normalizeArtifactRef(value));
    }
    return refs;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectArtifactRefs(item, refs));
    return refs;
  }

  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((child) =>
      collectArtifactRefs(child, refs),
    );
  }

  return refs;
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
              mimeType: mimeTypeForArtifactName(file.relativePath),
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

    if (toolName === "google.drive.uploadArtifact") {
      const uploaded = await uploadSandboxArtifactToDrive({
        agentRunId: input.agentRunId,
        toolCallId: toolCall.id,
        workspaceId: input.workspaceId,
        state: input.state,
        artifactId: asString(request.artifactId),
        artifactName:
          asString(request.artifactName) ||
          asString(request.path) ||
          asString(request.name),
        outputName: asString(request.outputName) || asString(request.name),
        mimeType: asString(request.mimeType),
      });
      artifacts.push(uploaded.artifact);
      result = uploaded.uploaded;
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

    if (toolName === "google.sheets.createSpreadsheet") {
      const rows = Array.isArray(request.rows) ? (request.rows as unknown[][]) : [];
      const created = await createGoogleSheet({
        workspaceId: input.workspaceId,
        title: asString(request.title, `${input.agent.name} generated sheet`),
        sheetTitle: asString(request.sheetTitle, "Sheet1"),
        range: asString(request.range, "Sheet1!A1"),
        rows,
      });
      input.state.createdGoogleFileIds.add(created.fileId);
      input.state.createdGoogleFiles.push(created);
      const artifact = artifactOutput(
        await createArtifact({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          artifactType: "google_sheet",
          name: created.fileName,
          location: created.webViewLink,
          mimeType: created.mimeType,
          payload: created,
        }),
      );
      artifacts.push(artifact);
      result = created;
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
      const artifactRefs = Array.from(collectArtifactRefs(request.requests));
      const artifactUrlByName = new Map<string, string>();
      for (const artifactName of artifactRefs) {
        const uploaded = await uploadSandboxArtifactToDrive({
          agentRunId: input.agentRunId,
          toolCallId: toolCall.id,
          workspaceId: input.workspaceId,
          state: input.state,
          artifactName,
          outputName: path.basename(artifactName),
        });
        artifacts.push(uploaded.artifact);
        artifactUrlByName.set(artifactName, uploaded.uploaded.downloadUrl);
      }
      const requests = replaceArtifactRefsDeep(
        asObjectArray(request.requests),
        (artifactName) => artifactUrlByName.get(artifactName) ?? null,
      );
      result = await batchUpdateGoogleSlides({
        workspaceId: input.workspaceId,
        presentationId,
        requests: asObjectArray(requests),
      });
      if (artifactUrlByName.size > 0) {
        result = {
          ...asRecord(result),
          artifactImagesResolved: Array.from(artifactUrlByName.entries()).map(
            ([artifactName, url]) => ({ artifactName, url }),
          ),
        };
      }
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
        blockingSlideIssues: auditResult.blockingSlideIssues,
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

  for (
    let finalizationStep = 0;
    finalizationStep < MAX_DETERMINISTIC_FINALIZATION_STEPS;
    finalizationStep += 1
  ) {
    const deterministicCalls = deterministicWorkflowCalls({
      agent: input.agent,
      requirements: workflowRequirements,
      toolResults,
      availableTools,
    });
    if (deterministicCalls.length === 0) {
      break;
    }

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
  }

  const unresolvedWorkflowOutcomes = missingWorkflowOutcomes({
    requirements: workflowRequirements,
    toolResults,
    availableTools,
  });

  let final: GenerateTextResult;
  if (unresolvedWorkflowOutcomes.length > 0 && toolResults.length > 0) {
    final = buildFallbackFinalResult({
      provider: input.provider,
      model: input.model,
      toolResults,
      protectedActionRequests: state.protectedActionRequests,
      llmResults,
      error: new Error(
        `Run completed with unresolved workflow blockers: ${unresolvedWorkflowOutcomes.join("; ")}`,
      ),
    });
  } else if (
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
    "For spreadsheet/table outputs, create a native run-owned Google Sheet when the tool is selected, then read back or update important ranges as needed.",
    "Create/copy/write only run-owned outputs unless approval is explicitly granted.",
  ].join("\n");
}

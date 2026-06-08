import { Prisma, type Agent, type AgentFile } from "@prisma/client";
import {
  batchUpdateGoogleSlides,
  copyGoogleDriveFile,
  createGoogleDriveTextFile,
  createNotionPage,
  readGoogleSheetRange,
  replaceGoogleSlidesText,
  updateGoogleSheetRange,
} from "@/lib/connectors/write";
import { getDb } from "@/lib/db";
import type { LlmProvider } from "@/lib/env";
import { createLlmClient } from "@/lib/llm";
import {
  GENERIC_AGENT_TOOLS,
  genericToolDefinition,
  isGenericAgentToolKey,
  type GenericAgentToolKey,
} from "@/lib/tools/definitions";
import { runPythonInSandbox } from "@/lib/tools/python-sandbox";

const MAX_TOOL_ITERATIONS = 3;
const MAX_TOOL_CALLS_PER_ITERATION = 5;

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
}) {
  return [
    "You are planning tool calls for a Summon agent run.",
    "Return only JSON. Do not wrap it in prose.",
    "Use only the available tools listed below.",
    "Allowed without approval: reading data, running helper code in the sandbox, creating new files, copying templates, editing files created/copied in this same run, and creating Notion memory pages.",
    "Do not request destructive actions. Do not edit existing client/team files unless they were created or copied by this run.",
    "For Google Slides template work, first copy the template deck, then update the copied deck.",
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
    input.basePrompt,
    "",
    "Prior tool results:",
    JSON.stringify(input.priorResults, null, 2),
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
}) {
  return [
    input.basePrompt,
    "",
    "Tool execution results:",
    JSON.stringify(input.toolResults, null, 2),
    "",
    "Write the final response for the Summon team.",
    "Include evidence used, generated artifacts with links, what was not verified, recommendations, and any blocked protected actions.",
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
      const sandbox = await runPythonInSandbox({
        runId: input.agentRunId,
        files: input.agent.files,
        code: asString(request.code),
        entryFile: asString(request.entryFile),
        args: asStringArray(request.args),
      });
      const generatedArtifacts = [];
      for (const file of sandbox.generatedFiles) {
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

    if (toolName === "google.slides.replaceText") {
      const presentationId = parseGoogleFileId(asString(request.presentationId));
      requireCreatedGoogleFile(input.state, presentationId, toolName);
      const replacements = asObjectArray(request.replacements).map((replacement) => ({
        find: asString(replacement.find),
        replace: asString(replacement.replace),
      })).filter((replacement) => replacement.find);
      result = await replaceGoogleSlidesText({
        workspaceId: input.workspaceId,
        presentationId,
        replacements,
      });
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
      createdGoogleFiles: [] as RuntimeState["createdGoogleFiles"],
    };
  }

  const client = createLlmClient(input.provider);
  const state: RuntimeState = {
    createdGoogleFileIds: new Set(),
    createdGoogleFiles: [],
    protectedActionRequests: [],
  };
  const toolResults: unknown[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const plan = await client.generateText({
      systemPrompt: input.systemPrompt,
      model: input.model,
      prompt: buildPlannerPrompt({
        agent: input.agent,
        basePrompt: input.basePrompt,
        availableTools,
        priorResults: toolResults,
      }),
    });

    let calls: PlannedToolCall[] = [];
    try {
      calls = parsePlannedToolCalls(plan.text);
    } catch {
      break;
    }

    if (calls.length === 0) {
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

  const final = await client.generateText({
    systemPrompt: input.systemPrompt,
    model: input.model,
    prompt: buildFinalPrompt({
      basePrompt: input.basePrompt,
      toolResults,
      protectedActionRequests: state.protectedActionRequests,
    }),
  });

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
    "Create/copy/write only run-owned outputs unless approval is explicitly granted.",
  ].join("\n");
}

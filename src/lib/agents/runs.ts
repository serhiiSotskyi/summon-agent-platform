import { Prisma } from "@prisma/client";
import {
  getRetainedUntil,
  SUMMON_MEMORY_SYSTEM_INSTRUCTION,
} from "@/lib/agents/defaults";
import { buildAgentFilesPromptSection } from "@/lib/agents/files";
import {
  genericToolInstruction,
  runAgentToolLoop,
} from "@/lib/agents/tool-loop";
import { canRunAgent } from "@/lib/app/permissions";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { collectReadOnlyConnectorContext } from "@/lib/connectors/read-only";
import {
  batchUpdateGoogleDoc,
  batchUpdateGoogleSlides,
  replaceGoogleDocText,
  replaceGoogleSlidesText,
  updateGoogleSheetRange,
  updateGoogleSlidesTableCell,
  updateGoogleSlidesTextElement,
} from "@/lib/connectors/write";
import { getDb } from "@/lib/db";
import { llmProviderSchema } from "@/lib/env";
import { createLlmClient } from "@/lib/llm";
import { getPricingMetadata } from "@/lib/llm/pricing";
import {
  enqueueManualRun,
  type ApprovedActionJob,
  type ManualAgentRunJob,
} from "@/lib/queue/agent-runs";
import { normalizeAgentToolSelection } from "@/lib/tools/definitions";

type CreateManualAgentRunInput = {
  agentId: string;
  workspaceId: string;
  triggeredById: string;
};

type CreateScheduledAgentRunInput = {
  agentId: string;
  workspaceId: string;
};

const DEFAULT_AGENT_RUN_TIMEOUT_MS = 600_000;
const CONNECTOR_CONTEXT_TIMEOUT_MS = 45_000;

function normalizeTools(tools: Prisma.JsonValue) {
  if (!Array.isArray(tools)) {
    return normalizeAgentToolSelection([]);
  }

  return normalizeAgentToolSelection(
    tools.filter((tool): tool is string => typeof tool === "string"),
  );
}

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.InputJsonObject)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function connectorName(key: string) {
  return connectorCatalog.find((connector) => connector.key === key)?.name ?? key;
}

function normalizeRunError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Agent run failed unexpectedly.";

  if (/timed out|timeout|aborted/i.test(message)) {
    return "Agent run timed out before the provider returned a response. Try again or use a faster model.";
  }

  if (message.startsWith("Missing required environment variable: ")) {
    const variable = message.replace("Missing required environment variable: ", "");
    return `Missing provider configuration: ${variable}. Add it to .env and restart the worker.`;
  }

  if (/incorrect api key|invalid api key|invalid_api_key|401/i.test(message)) {
    return "The selected LLM provider rejected the configured API key. Check the provider key in .env and restart the worker.";
  }

  if (/rate limit|429/i.test(message)) {
    return "The selected LLM provider rate limited this run. Try again later or switch models.";
  }

  return message;
}

function getAgentRunTimeoutMs() {
  const raw = process.env.AGENT_RUN_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : DEFAULT_AGENT_RUN_TIMEOUT_MS;

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AGENT_RUN_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Agent run timed out after ${timeoutMs}ms.`));
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

function summarizeOutput(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Run completed without textual output.";
  }

  return normalized.length > 320
    ? `${normalized.slice(0, 317).trimEnd()}...`
    : normalized;
}

function connectorTimeoutContext(tools: string[], error: unknown) {
  const message =
    error instanceof Error ? error.message : "Connector context timed out.";
  return {
    connectedTools: [],
    missingTools: tools,
    results: [
      {
        connectorType: "connector-context",
        connectorName: "Connector context",
        status: "error" as const,
        summary:
          "Read-only connector context was skipped because it did not finish within the run timeout.",
        blockers: [message],
        records: [],
      },
    ],
    blockers: [message],
  };
}

function buildReadOnlyRunPrompt({
  agentName,
  agentFilesContext,
  connectorContext,
  toolExecutionContext,
  tools,
}: {
  agentName: string;
  agentFilesContext?: string;
  connectorContext: Awaited<ReturnType<typeof collectReadOnlyConnectorContext>>;
  toolExecutionContext?: string;
  tools: string[];
}) {
  return [
    `Run "${agentName}" using the read-only connector evidence below.`,
    "External tools may have been called. Do not claim any budget edit, campaign change, delete action, or external send happened unless tool output explicitly says so.",
    genericToolInstruction(),
    "Produce a concise operational result for a non-technical Summon team member.",
    "Base the answer on the evidence. Cite source titles and URLs from connector records when available.",
    "If a connector is blocked or errored, say exactly what is missing instead of guessing.",
    "If no evidence record supports a claim, label that claim as not found or unverified.",
    "",
    "Include these sections:",
    "1. Evidence used.",
    "2. What I found.",
    "3. Budget or reporting risks.",
    "4. What I could not verify.",
    "5. Recommendations.",
    "6. Changes that would need human approval.",
    "",
    `Requested tools: ${tools.map(connectorName).join(", ") || "none"}.`,
    `Connected tools: ${connectorContext.connectedTools.map(connectorName).join(", ") || "none"}.`,
    `Missing tools: ${connectorContext.missingTools.map(connectorName).join(", ") || "none"}.`,
    "",
    agentFilesContext ?? "",
    agentFilesContext ? "" : "",
    toolExecutionContext ?? "",
    toolExecutionContext ? "" : "",
    "Connector evidence:",
    JSON.stringify(connectorContext.results, null, 2),
  ].join("\n");
}

async function createApprovalIfNeeded({
  agentId,
  agentRunId,
  llmOutput,
  workspaceId,
  requestedById,
  tools,
  actionPermissionMode,
}: {
  agentId: string;
  agentRunId: string;
  llmOutput: string;
  workspaceId: string;
  requestedById?: string;
  tools: string[];
  actionPermissionMode: string;
}) {
  if (tools.length === 0) {
    return null;
  }

  const db = getDb();
  const existing = await db.approvalRequest.findFirst({
    where: {
      agentRunId,
      status: "PENDING",
    },
  });

  if (existing) {
    return existing;
  }

  const blockedToolCalls = await db.toolCall.findMany({
    where: {
      agentRunId,
      status: "BLOCKED",
    },
    orderBy: { loggedAt: "asc" },
    select: {
      id: true,
      toolName: true,
      connectorType: true,
      request: true,
      error: true,
      loggedAt: true,
    },
  });

  return db.approvalRequest.create({
    data: {
      workspaceId,
      agentId,
      agentRunId,
      riskLevel: "PROTECTED",
      status: "PENDING",
      requestedById,
      requestedAction: {
        title: "Review protected next actions",
        description:
          actionPermissionMode === "FULL_ACCESS"
            ? "A protected/destructive tool attempt was blocked even though the agent has full access. Review before allowing mutation of an existing external file or system."
            : "This run attempted protected actions that may affect external systems. Review before allowing future mutations.",
        mode: "protected_action_review",
        tools,
        blockedToolCalls: blockedToolCalls.map((call) => ({
          id: call.id,
          toolName: call.toolName,
          connectorType: call.connectorType,
          request: call.request,
          error: call.error,
          loggedAt: call.loggedAt.toISOString(),
        })),
        outputPreview: summarizeOutput(llmOutput),
      },
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    },
  });
}

export async function createManualAgentRun(input: CreateManualAgentRunInput) {
  const db = getDb();

  const [agent, membership] = await Promise.all([
    db.agent.findFirst({
      where: {
        id: input.agentId,
        workspaceId: input.workspaceId,
        status: { not: "DELETED" },
      },
    }),
    db.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.triggeredById,
        },
      },
    }),
  ]);

  if (!agent) {
    throw new Error("Agent not found.");
  }

  if (!membership || membership.status !== "ACTIVE" || !canRunAgent(membership.role)) {
    throw new Error("You do not have permission to run agents in this workspace.");
  }

  const run = await db.agentRun.create({
    data: {
      agentId: agent.id,
      triggeredById: input.triggeredById,
      triggerType: "MANUAL",
      status: "QUEUED",
      retainedUntil: getRetainedUntil(),
      summary: "Manual run queued.",
    },
  });

  try {
    await enqueueManualRun({
      kind: "manual-run",
      agentId: agent.id,
      agentRunId: run.id,
      workspaceId: input.workspaceId,
      triggeredById: input.triggeredById,
    });
  } catch (error) {
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: normalizeRunError(error),
        completedAt: new Date(),
      },
    });
  }

  return run;
}

export async function createScheduledAgentRun(input: CreateScheduledAgentRunInput) {
  const db = getDb();

  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.agentId}))`;

      const agent = await tx.agent.findFirst({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          status: "ACTIVE",
          triggerType: "SCHEDULED",
        },
      });

      if (!agent) {
        return null;
      }

      const existingActiveRun = await tx.agentRun.findFirst({
        where: {
          agentId: agent.id,
          triggerType: "SCHEDULED",
          status: { in: ["QUEUED", "RUNNING"] },
        },
        orderBy: { triggeredAt: "desc" },
      });

      if (existingActiveRun) {
        return null;
      }

      return tx.agentRun.create({
        data: {
          agentId: agent.id,
          triggerType: "SCHEDULED",
          status: "QUEUED",
          retainedUntil: getRetainedUntil(),
          summary: "Scheduled run queued.",
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
}

export async function executeAgentRun(job: ManualAgentRunJob) {
  const db = getDb();
  const startedAt = Date.now();

  try {
    const run = await db.agentRun.findFirst({
      where: {
        id: job.agentRunId,
        agentId: job.agentId,
        agent: { workspaceId: job.workspaceId },
      },
      include: {
        agent: {
          include: {
            files: {
              orderBy: { createdAt: "desc" },
            },
          },
        },
      },
    });

    if (!run) {
      throw new Error("Agent run not found.");
    }

    if (run.status === "CANCELLED" || run.status === "SUCCESS" || run.status === "FAILED") {
      return run;
    }

    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        error: null,
        completedAt: null,
        summary: "Worker picked up the run.",
      },
    });

    const tools = normalizeTools(run.agent.tools);
    const agentFilesContext = buildAgentFilesPromptSection(run.agent.files);
    const connectorContext = await withTimeout(
      collectReadOnlyConnectorContext({
        workspaceId: job.workspaceId,
        tools,
      }),
      CONNECTOR_CONTEXT_TIMEOUT_MS,
    ).catch((error) => connectorTimeoutContext(tools, error));
    const provider = llmProviderSchema.catch("openai").parse(run.agent.llmProvider);
    const systemPrompt = [
      SUMMON_MEMORY_SYSTEM_INSTRUCTION,
      genericToolInstruction(),
      run.agent.systemPrompt,
    ].join("\n\n");
    const basePrompt = buildReadOnlyRunPrompt({
      agentName: run.agent.name,
      agentFilesContext,
      connectorContext,
      tools,
    });
    const toolLoopResult = await withTimeout(
      runAgentToolLoop({
        agentRunId: run.id,
        workspaceId: job.workspaceId,
        agent: run.agent,
        provider,
        model: run.agent.llmModel,
        basePrompt,
        systemPrompt,
        selectedTools: tools,
      }),
      getAgentRunTimeoutMs(),
    );
    const result =
      toolLoopResult.final ??
      (await withTimeout(
        createLlmClient(provider).generateText({
          systemPrompt,
          model: run.agent.llmModel,
          prompt: basePrompt,
        }),
        getAgentRunTimeoutMs(),
      ));
    const approval = await createApprovalIfNeeded({
      agentId: run.agent.id,
      agentRunId: run.id,
      workspaceId: job.workspaceId,
      requestedById: job.triggeredById,
      llmOutput: result.text,
      tools: toolLoopResult.protectedActionRequests,
      actionPermissionMode: run.agent.actionPermissionMode,
    });
    const output: Prisma.InputJsonObject = {
      mode:
        toolLoopResult.toolCalls.length > 0
          ? "generic_tool_loop"
          : "read_only",
      provider: result.provider,
      model: result.model,
      usage: (result.usage ?? null) as Prisma.InputJsonValue,
      cost: getPricingMetadata({
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        estimatedCostUsd: result.estimatedCostUsd,
      }) as Prisma.InputJsonObject,
      text: result.text,
      requestedTools: tools,
      agentFiles: run.agent.files.map((file) => ({
        id: file.id,
        name: file.name,
        role: file.role,
        sourceType: file.sourceType,
        url: file.url,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      })) as unknown as Prisma.InputJsonValue,
      connectedTools: connectorContext.connectedTools,
      missingTools: connectorContext.missingTools,
      connectorResults:
        connectorContext.results as unknown as Prisma.InputJsonValue,
      blockers: [
        ...connectorContext.blockers,
        ...toolLoopResult.protectedActionRequests,
        ...(toolLoopResult.unresolvedWorkflowOutcomes ?? []),
      ],
      workflowStatus: toolLoopResult.workflowStatus,
      unresolvedWorkflowOutcomes:
        (toolLoopResult.unresolvedWorkflowOutcomes ?? []) as unknown as Prisma.InputJsonValue,
      toolResults: toolLoopResult.toolResults as unknown as Prisma.InputJsonValue,
      createdGoogleFiles:
        toolLoopResult.createdGoogleFiles as unknown as Prisma.InputJsonValue,
      toolCalls: toolLoopResult.toolCalls as Prisma.InputJsonArray,
      artifacts: toolLoopResult.artifacts as Prisma.InputJsonArray,
      approvalRequestId: approval?.id ?? null,
      note: toolLoopResult.toolCalls.length > 0
        ? "Allowed create/copy/write tools may have produced new artifacts. No destructive actions, sends, budget edits, or campaign changes were made."
        : "Read-only connector calls may have been executed. No external writes, sends, budget edits, or campaign changes were made.",
    };

    const unresolvedWorkflowOutcomes = toolLoopResult.unresolvedWorkflowOutcomes ?? [];
    const status = unresolvedWorkflowOutcomes.length > 0 ? "FAILED" : "SUCCESS";
    const summary =
      unresolvedWorkflowOutcomes.length > 0
        ? "Agent run completed with unresolved workflow blockers."
        : summarizeOutput(result.text);
    const error =
      unresolvedWorkflowOutcomes.length > 0
        ? unresolvedWorkflowOutcomes.join(" ")
        : null;

    return db.agentRun.update({
      where: { id: run.id },
      data: {
        status,
        summary,
        error,
        output,
        costEstimate:
          result.estimatedCostUsd !== null && result.estimatedCostUsd !== undefined
            ? new Prisma.Decimal(result.estimatedCostUsd.toFixed(6))
            : null,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    const message = normalizeRunError(error);
    return db.agentRun.update({
      where: { id: job.agentRunId },
      data: {
        status: "FAILED",
        error: message,
        summary: "Agent run failed.",
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
  }
}

export async function executeApprovedAction(job: ApprovedActionJob) {
  const db = getDb();
  const approval = await db.approvalRequest.findFirst({
    where: {
      id: job.approvalRequestId,
      workspaceId: job.workspaceId,
      status: "APPROVED",
    },
    include: {
      agentRun: true,
    },
  });

  if (!approval) {
    return null;
  }

  const executedAt = new Date();
  const requestedAction = asRecord(approval.requestedAction);
  const existingExecution = asRecord(requestedAction.execution);

  if (Object.keys(existingExecution).length > 0) {
    return approval.agentRun;
  }

  const runningExecution: Prisma.InputJsonObject = {
    approvalRequestId: approval.id,
    status: "RUNNING",
    startedAt: executedAt.toISOString(),
    executedBy: "agent-approved-actions-worker",
    reviewedById: job.reviewedById,
  };

  await db.approvalRequest.update({
    where: { id: approval.id },
    data: {
      requestedAction: {
        ...requestedAction,
        execution: runningExecution,
      },
    },
  });

  const replayResults = [];
  const blockedToolCalls = asObjectArray(requestedAction.blockedToolCalls);

  for (const blockedToolCall of blockedToolCalls) {
    const toolName = asString(blockedToolCall.toolName);
    const originalRequest = asRecord(blockedToolCall.request);
    const parameters = asRecord(originalRequest.parameters);
    const toolCall = approval.agentRunId
      ? await db.toolCall.create({
          data: {
            agentRunId: approval.agentRunId,
            connectorType: toolName.split(".")[0] ?? "tool",
            toolName,
            status: "RUNNING",
            startedAt: new Date(),
            request: {
              action: toolName,
              parameters: parameters as Prisma.InputJsonObject,
              approvedFromToolCallId: asString(blockedToolCall.id),
            } as Prisma.InputJsonObject,
            metadata: {
              approvalReplay: true,
              approvalRequestId: approval.id,
            } as Prisma.InputJsonObject,
          },
        })
      : null;
    const startedAt = Date.now();

    try {
      const result = await executeApprovedTool({
        workspaceId: approval.workspaceId,
        toolName,
        parameters,
      });

      if (toolCall) {
        await db.toolCall.update({
          where: { id: toolCall.id },
          data: {
            status: "SUCCEEDED",
            response: result as Prisma.InputJsonValue,
            completedAt: new Date(),
            durationMs: Date.now() - startedAt,
          },
        });
      }

      replayResults.push({
        toolName,
        status: "SUCCEEDED",
        result,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approved action failed.";
      if (toolCall) {
        await db.toolCall.update({
          where: { id: toolCall.id },
          data: {
            status: "FAILED",
            error: message,
            completedAt: new Date(),
            durationMs: Date.now() - startedAt,
          },
        });
      }

      replayResults.push({
        toolName,
        status: "FAILED",
        error: message,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const hadReplayPayload = replayResults.length > 0;
  const replayFailed = replayResults.some((result) => result.status === "FAILED");
  const finishedAt = new Date();
  const executionRecord: Prisma.InputJsonObject = {
    approvalRequestId: approval.id,
    status: replayFailed ? "FAILED" : "COMPLETED",
    executedAt: finishedAt.toISOString(),
    executedBy: "agent-approved-actions-worker",
    reviewedById: job.reviewedById,
    mode: hadReplayPayload ? "approved_tool_replay" : "approval_record_only",
    message: hadReplayPayload
      ? replayFailed
        ? "Approved action replay finished with one or more failed tool calls."
        : "Approved action replay completed for supported connector tools."
      : "Approval execution completed in record-only mode. No structured blocked tool payload was available.",
    results: replayResults as unknown as Prisma.InputJsonValue,
  };

  await db.approvalRequest.update({
    where: { id: approval.id },
    data: {
      requestedAction: {
        ...requestedAction,
        execution: executionRecord,
      },
    },
  });

  if (!approval.agentRun) {
    return db.approvalRequest.findUnique({ where: { id: approval.id } });
  }

  const approvalExecutionSummary = hadReplayPayload
    ? replayFailed
      ? "Protected action approval replay finished with failures."
      : "Protected action approval replay completed."
    : "Protected action approval was executed in record-only mode.";
  const currentSummary = approval.agentRun.summary;
  const shouldReplaceRunSummary =
    !currentSummary ||
    currentSummary === "Manual run queued." ||
    currentSummary === "Worker picked up the run." ||
    currentSummary.startsWith("Protected action approval");

  return db.agentRun.update({
    where: { id: approval.agentRun.id },
    data: {
      summary: shouldReplaceRunSummary ? approvalExecutionSummary : currentSummary,
      output: {
        ...asJsonObject(approval.agentRun.output),
        approvedActionExecution: executionRecord,
        approvedActionExecutionSummary: approvalExecutionSummary,
      },
    },
  });
}

async function executeApprovedTool(input: {
  workspaceId: string;
  toolName: string;
  parameters: Record<string, unknown>;
}) {
  switch (input.toolName) {
    case "google.sheets.updateRange":
      return updateGoogleSheetRange({
        workspaceId: input.workspaceId,
        spreadsheetId: asString(input.parameters.spreadsheetId),
        range: asString(input.parameters.range),
        values: Array.isArray(input.parameters.values)
          ? (input.parameters.values as unknown[][])
          : [],
      }) as Promise<Prisma.InputJsonObject>;
    case "google.slides.updateText":
      return updateGoogleSlidesTextElement({
        workspaceId: input.workspaceId,
        presentationId: asString(input.parameters.presentationId),
        objectId: asString(input.parameters.objectId),
        text: asString(input.parameters.text),
      }) as Promise<Prisma.InputJsonObject>;
    case "google.slides.updateTableCell":
      return updateGoogleSlidesTableCell({
        workspaceId: input.workspaceId,
        presentationId: asString(input.parameters.presentationId),
        tableObjectId: asString(input.parameters.tableObjectId),
        rowIndex: asNumber(input.parameters.rowIndex),
        columnIndex: asNumber(input.parameters.columnIndex),
        text: asString(input.parameters.text),
      }) as Promise<Prisma.InputJsonObject>;
    case "google.slides.replaceText":
      return replaceGoogleSlidesText({
        workspaceId: input.workspaceId,
        presentationId: asString(input.parameters.presentationId),
        replacements: asObjectArray(input.parameters.replacements)
          .map((replacement) => ({
            find: asString(replacement.find),
            replace: asString(replacement.replace),
          }))
          .filter((replacement) => replacement.find),
      }) as Promise<Prisma.InputJsonObject>;
    case "google.slides.batchUpdate":
      return batchUpdateGoogleSlides({
        workspaceId: input.workspaceId,
        presentationId: asString(input.parameters.presentationId),
        requests: asObjectArray(input.parameters.requests),
      }) as Promise<Prisma.InputJsonObject>;
    case "google.docs.replaceText":
      return replaceGoogleDocText({
        workspaceId: input.workspaceId,
        documentId: asString(input.parameters.documentId),
        replacements: asObjectArray(input.parameters.replacements)
          .map((replacement) => ({
            find: asString(replacement.find),
            replace: asString(replacement.replace),
          }))
          .filter((replacement) => replacement.find),
      }) as Promise<Prisma.InputJsonObject>;
    case "google.docs.batchUpdate":
      return batchUpdateGoogleDoc({
        workspaceId: input.workspaceId,
        documentId: asString(input.parameters.documentId),
        requests: asObjectArray(input.parameters.requests),
      }) as Promise<Prisma.InputJsonObject>;
    default:
      throw new Error(
        `Approved action replay is not implemented for ${input.toolName}. No external write was executed.`,
      );
  }
}

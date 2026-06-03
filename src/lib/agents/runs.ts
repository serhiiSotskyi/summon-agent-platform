import { Prisma } from "@prisma/client";
import { getRetainedUntil } from "@/lib/agents/defaults";
import { canRunAgent } from "@/lib/app/permissions";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { collectReadOnlyConnectorContext } from "@/lib/connectors/read-only";
import { getDb } from "@/lib/db";
import { llmProviderSchema } from "@/lib/env";
import { createLlmClient } from "@/lib/llm";
import { getAgentRunQueue, type AgentRunJob } from "@/lib/queue/agent-runs";

type CreateManualAgentRunInput = {
  agentId: string;
  workspaceId: string;
  triggeredById: string;
};

const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;

function normalizeTools(tools: Prisma.JsonValue) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.filter((tool): tool is string => typeof tool === "string");
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

function buildReadOnlyRunPrompt({
  agentName,
  connectorContext,
  tools,
}: {
  agentName: string;
  connectorContext: Awaited<ReturnType<typeof collectReadOnlyConnectorContext>>;
  tools: string[];
}) {
  return [
    `Run "${agentName}" using the read-only connector evidence below.`,
    "External read-only tools may have been called. Do not claim any write, mutation, send, budget edit, or campaign change happened.",
    "Produce a concise operational result for a non-technical Summon team member.",
    "Base the answer on the evidence. If a connector is blocked or errored, say exactly what is missing instead of guessing.",
    "",
    "Include these sections:",
    "1. What I found from read-only checks.",
    "2. Budget or performance risks.",
    "3. Recommended next actions.",
    "4. Missing setup or connector blockers.",
    "5. Changes that would need human approval.",
    "",
    `Requested tools: ${tools.map(connectorName).join(", ") || "none"}.`,
    `Connected tools: ${connectorContext.connectedTools.map(connectorName).join(", ") || "none"}.`,
    `Missing tools: ${connectorContext.missingTools.map(connectorName).join(", ") || "none"}.`,
    "",
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
  if (actionPermissionMode !== "ASK_BEFORE_CHANGES" || tools.length === 0) {
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
          "This read-only run proposed actions that may affect external systems. Review before allowing future mutations.",
        mode: "read_only",
        tools,
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
    await getAgentRunQueue().add("manual-run", {
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

export async function executeAgentRun(job: AgentRunJob) {
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
        agent: true,
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
    const connectorContext = await collectReadOnlyConnectorContext({
      workspaceId: job.workspaceId,
      tools,
    });
    const provider = llmProviderSchema.catch("openai").parse(run.agent.llmProvider);
    const result = await withTimeout(
      createLlmClient(provider).generateText({
        systemPrompt: run.agent.systemPrompt,
        model: run.agent.llmModel,
        prompt: buildReadOnlyRunPrompt({
          agentName: run.agent.name,
          connectorContext,
          tools,
        }),
      }),
      getAgentRunTimeoutMs(),
    );
    const approval = await createApprovalIfNeeded({
      agentId: run.agent.id,
      agentRunId: run.id,
      workspaceId: job.workspaceId,
      requestedById: job.triggeredById,
      llmOutput: result.text,
      tools,
      actionPermissionMode: run.agent.actionPermissionMode,
    });
    const output: Prisma.InputJsonObject = {
      mode: "read_only",
      provider: result.provider,
      model: result.model,
      text: result.text,
      requestedTools: tools,
      connectedTools: connectorContext.connectedTools,
      missingTools: connectorContext.missingTools,
      connectorResults:
        connectorContext.results as unknown as Prisma.InputJsonValue,
      blockers: connectorContext.blockers,
      approvalRequestId: approval?.id ?? null,
      note: "Read-only connector calls may have been executed. No external writes, sends, budget edits, or campaign changes were made.",
    };

    return db.agentRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        summary: summarizeOutput(result.text),
        output,
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

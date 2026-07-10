import { Prisma, type ApprovalStatus, type TriggerType } from "@prisma/client";
import { z } from "zod";
import {
  registerAgentScheduler,
  removeAgentScheduler,
} from "@/lib/agents/scheduler";
import {
  buildScheduleConfig,
  readScheduleConfig,
  withAgentSchedulerId,
} from "@/lib/agents/schedules";
import { SUMMON_MEMORY_SYSTEM_INSTRUCTION } from "@/lib/agents/defaults";
import { createAgentFile } from "@/lib/agents/files";
import { createManualAgentRun } from "@/lib/agents/runs";
import { canCreateAgent, canManageWorkspace } from "@/lib/app/permissions";
import { getWorkspaceReadiness } from "@/lib/app/readiness";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { getDb } from "@/lib/db";
import { getDefaultLlmSettings, getEnv, llmProviderSchema } from "@/lib/env";
import type { McpUserContext } from "@/lib/mcp/context";
import { enqueueApprovedAction } from "@/lib/queue/agent-runs";
import {
  GENERIC_AGENT_TOOLS,
  normalizeAgentToolSelection,
} from "@/lib/tools/definitions";

type JsonSchema = {
  [key: string]: unknown;
  type: "object";
};

export type McpToolDefinition = {
  annotations: {
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
    readOnlyHint: boolean;
  };
  description: string;
  inputSchema: JsonSchema;
  name: string;
  title: string;
};

type ToolResult = {
  content: Array<{ text: string; type: "text" }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

const workspaceIdSchema = {
  workspace_id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional Summon workspace id. Defaults to the authorized user's selected workspace."),
};

const scheduleSchema = z
  .object({
    frequency: z.enum(["HOURLY", "DAILY", "WEEKLY"]).default("DAILY"),
    minute: z.union([z.string(), z.number()]).optional(),
    time_of_day: z.string().optional(),
    timezone: z.string().optional(),
    weekday: z.union([z.string(), z.number()]).optional(),
  })
  .optional();

const actionPermissionModeSchema = z
  .enum(["ASK_BEFORE_CHANGES", "FULL_ACCESS"])
  .optional();
const deliveryPermissionModeSchema = z
  .enum(["ASK_BEFORE_SENDING", "SEND_AUTOMATICALLY"])
  .optional();
const agentReferenceRoleSchema = z.enum([
  "input_data",
  "helper_code",
  "template",
  "reference",
  "output_destination",
  "other",
]);
const agentReferenceSchema = z.object({
  content_text: z.string().optional(),
  description: z.string().optional(),
  mime_type: z.string().optional(),
  name: z.string().min(1),
  role: agentReferenceRoleSchema.default("reference"),
  source_type: z.enum(["external_url", "uploaded_text"]).default("external_url"),
  url: z.string().optional(),
});

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } satisfies JsonSchema;
}

const workspaceJsonProperty = {
  type: "string",
  description:
    "Optional Summon workspace id. Omit to use the authorized user's default active workspace.",
};

const toolKeysProperty = {
  type: "array",
  description:
    "Optional Summon connector/tool keys. Omit to keep the platform default tool set.",
  items: {
    type: "string",
  },
};

const scheduleJsonProperty = {
  type: "object",
  description:
    "Schedule configuration for scheduled agents. Supports HOURLY, DAILY, and WEEKLY.",
  properties: {
    frequency: { type: "string", enum: ["HOURLY", "DAILY", "WEEKLY"] },
    timezone: { type: "string", default: "Europe/London" },
    minute: { type: ["string", "number"], description: "Minute for HOURLY schedules, 0-59." },
    time_of_day: { type: "string", description: "HH:mm for DAILY/WEEKLY schedules." },
    weekday: {
      type: ["string", "number"],
      description: "Weekday for WEEKLY schedules, 0 Sunday through 6 Saturday.",
    },
  },
};

function defineTool(input: McpToolDefinition) {
  return input;
}

export const MCP_TOOLS = [
  defineTool({
    name: "summon_get_context",
    title: "Get Summon context",
    description:
      "Get the authorized Summon user, active workspace, available workspaces, roles, and recommended Claude workflow.",
    inputSchema: schema({ workspace_id: workspaceJsonProperty }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_health_check",
    title: "Check Summon readiness",
    description:
      "Check the authorized workspace readiness, including connector status, model/provider configuration, and common setup blockers.",
    inputSchema: schema({ workspace_id: workspaceJsonProperty }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_list_connectors",
    title: "List Summon connectors",
    description:
      "List available Summon connectors and whether the authorized workspace has active credentials for each.",
    inputSchema: schema({ workspace_id: workspaceJsonProperty }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_list_agents",
    title: "List Summon agents",
    description:
      "List non-deleted agents in the authorized workspace with status, trigger, model, and latest run summary.",
    inputSchema: schema({
      workspace_id: workspaceJsonProperty,
      status: {
        type: "string",
        enum: ["DRAFT", "ACTIVE", "PAUSED", "ERROR"],
        description: "Optional status filter.",
      },
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_get_agent",
    title: "Get Summon agent",
    description:
      "Get a Summon agent's configuration, attached files, recent runs, and pending approval count.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id"],
    ),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_create_agent",
    title: "Create Summon agent",
    description:
      "Create a Summon agent as a durable workspace automation. Prefer DRAFT, run a manual test, then activate if the result is acceptable.",
    inputSchema: schema(
      {
        action_permission_mode: {
          type: "string",
          enum: ["ASK_BEFORE_CHANGES", "FULL_ACCESS"],
          default: "ASK_BEFORE_CHANGES",
        },
        delivery_permission_mode: {
          type: "string",
          enum: ["ASK_BEFORE_SENDING", "SEND_AUTOMATICALLY"],
          default: "ASK_BEFORE_SENDING",
        },
        description: { type: "string" },
        llm_model: { type: "string" },
        llm_provider: { type: "string", enum: ["openai", "anthropic", "google"] },
        name: { type: "string" },
        prompt: {
          type: "string",
          description:
            "Plain-English user objective. Summon will wrap this with platform memory and safety instructions.",
        },
        schedule: scheduleJsonProperty,
        status: {
          type: "string",
          enum: ["DRAFT", "ACTIVE", "PAUSED"],
          default: "DRAFT",
        },
        system_prompt: {
          type: "string",
          description:
            "Optional complete system prompt. Use prompt instead unless you need precise low-level control.",
        },
        tools: toolKeysProperty,
        trigger_type: { type: "string", enum: ["MANUAL", "SCHEDULED"], default: "MANUAL" },
        workspace_id: workspaceJsonProperty,
      },
      ["name"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  }),
  defineTool({
    name: "summon_create_automation_from_brief",
    title: "Create Agent Platform automation from brief",
    description:
      "Turn a non-technical user's recurring task brief into a shared Agent Platform automation. Use after asking any missing questions about cadence, owner/workspace, sources, output, recipients, and approval rules. Creates a draft by default, can attach references, and can queue a test run.",
    inputSchema: schema(
      {
        action_permission_mode: {
          type: "string",
          enum: ["ASK_BEFORE_CHANGES", "FULL_ACCESS"],
          default: "ASK_BEFORE_CHANGES",
          description:
            "Use ASK_BEFORE_CHANGES unless the user explicitly grants full access.",
        },
        audience: {
          type: "string",
          description:
            "Who should use or review this automation, such as the whole team, client team, or named stakeholders.",
        },
        delivery_permission_mode: {
          type: "string",
          enum: ["ASK_BEFORE_SENDING", "SEND_AUTOMATICALLY"],
          default: "ASK_BEFORE_SENDING",
          description:
            "Use ASK_BEFORE_SENDING unless the user explicitly allows automatic delivery.",
        },
        desired_outcome: {
          type: "string",
          description:
            "The concrete result the recurring automation should produce each run.",
        },
        name: {
          type: "string",
          description:
            "Clear team-facing automation name. If omitted, Agent Platform derives one from the brief.",
        },
        references: {
          type: "array",
          description:
            "URLs or inline text references Claude collected while turning the task into an automation.",
          items: {
            type: "object",
            properties: {
              content_text: { type: "string" },
              description: { type: "string" },
              mime_type: { type: "string" },
              name: { type: "string" },
              role: {
                type: "string",
                enum: [
                  "input_data",
                  "helper_code",
                  "template",
                  "reference",
                  "output_destination",
                  "other",
                ],
              },
              source_type: {
                type: "string",
                enum: ["external_url", "uploaded_text"],
              },
              url: { type: "string" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
        run_test: {
          type: "boolean",
          default: false,
          description:
            "Queue a manual test run after creating the automation. Prefer true after the user confirms enough detail.",
        },
        schedule: scheduleJsonProperty,
        sharing_notes: {
          type: "string",
          description:
            "How the team should find, review, and use results from this automation.",
        },
        status: {
          type: "string",
          enum: ["DRAFT", "ACTIVE", "PAUSED"],
          default: "DRAFT",
          description:
            "Keep DRAFT until the test result is reviewed. Use ACTIVE only when the user explicitly asks to activate the schedule.",
        },
        success_criteria: {
          type: "string",
          description:
            "What a good run result looks like and how the team should evaluate it.",
        },
        task_brief: {
          type: "string",
          description:
            "The recurring task in the user's own words, including what they normally ask Claude to do.",
        },
        tools: toolKeysProperty,
        trigger_type: {
          type: "string",
          enum: ["MANUAL", "SCHEDULED"],
          default: "MANUAL",
        },
        workspace_id: workspaceJsonProperty,
      },
      ["task_brief"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  }),
  defineTool({
    name: "summon_update_agent",
    title: "Update Summon agent",
    description:
      "Update an existing Summon agent's prompt, tools, model, permissions, trigger, schedule, or metadata.",
    inputSchema: schema(
      {
        action_permission_mode: {
          type: "string",
          enum: ["ASK_BEFORE_CHANGES", "FULL_ACCESS"],
        },
        agent_id: { type: "string" },
        delivery_permission_mode: {
          type: "string",
          enum: ["ASK_BEFORE_SENDING", "SEND_AUTOMATICALLY"],
        },
        description: { type: "string" },
        llm_model: { type: "string" },
        llm_provider: { type: "string", enum: ["openai", "anthropic", "google"] },
        name: { type: "string" },
        prompt: { type: "string" },
        schedule: scheduleJsonProperty,
        system_prompt: { type: "string" },
        tools: toolKeysProperty,
        trigger_type: { type: "string", enum: ["MANUAL", "SCHEDULED"] },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  }),
  defineTool({
    name: "summon_activate_agent",
    title: "Activate Summon agent",
    description:
      "Activate an agent. Scheduled agents are registered with the worker scheduler as part of activation.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_pause_agent",
    title: "Pause Summon agent",
    description:
      "Pause an active agent and remove its scheduler registration if it has a scheduled trigger.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_delete_agent",
    title: "Delete Summon agent",
    description:
      "Soft-delete an agent and remove any scheduler registration. Use only when the user explicitly wants the agent removed.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_add_agent_file",
    title: "Attach Summon agent reference",
    description:
      "Attach a URL reference or inline text file to an agent so future runs can use it as input data, helper code, template, or reference material.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        content_text: {
          type: "string",
          description: "Inline text content when source_type is uploaded_text.",
        },
        description: { type: "string" },
        mime_type: { type: "string" },
        name: { type: "string" },
        role: {
          type: "string",
          enum: ["input_data", "helper_code", "template", "reference", "output_destination", "other"],
          default: "reference",
        },
        source_type: {
          type: "string",
          enum: ["external_url", "uploaded_text"],
          default: "external_url",
        },
        url: {
          type: "string",
          description: "External URL when source_type is external_url.",
        },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id", "name", "source_type"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  }),
  defineTool({
    name: "summon_remove_agent_file",
    title: "Remove Summon agent reference",
    description: "Remove an attached agent file/reference from a Summon agent.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        file_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id", "file_id"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_run_agent",
    title: "Run Summon agent",
    description:
      "Queue a manual run for an agent in the authorized workspace. Use this to test a draft before activating a schedule.",
    inputSchema: schema(
      {
        agent_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["agent_id"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  }),
  defineTool({
    name: "summon_get_run",
    title: "Get Summon run",
    description:
      "Get an agent run's status, summary, output, tool calls, artifacts, cost estimate, and approvals.",
    inputSchema: schema(
      {
        run_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["run_id"],
    ),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_wait_for_run",
    title: "Wait for Summon run",
    description:
      "Poll a queued/running agent run briefly, then return the current run detail. max_seconds is capped to keep Claude connector calls responsive.",
    inputSchema: schema(
      {
        max_seconds: { type: "number", default: 20 },
        run_id: { type: "string" },
        workspace_id: workspaceJsonProperty,
      },
      ["run_id"],
    ),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_list_approvals",
    title: "List Summon approvals",
    description:
      "List approval requests in the authorized workspace. Defaults to pending approvals.",
    inputSchema: schema({
      status: {
        type: "string",
        enum: ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "ALL"],
        default: "PENDING",
      },
      workspace_id: workspaceJsonProperty,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  }),
  defineTool({
    name: "summon_review_approval",
    title: "Review Summon approval",
    description:
      "Approve or reject a pending protected action. Approving may queue the approved-action worker replay for previously blocked tool calls.",
    inputSchema: schema(
      {
        approval_id: { type: "string" },
        status: { type: "string", enum: ["APPROVED", "REJECTED"] },
        workspace_id: workspaceJsonProperty,
      },
      ["approval_id", "status"],
    ),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true,
      idempotentHint: true,
    },
  }),
] satisfies McpToolDefinition[];

function textResult(data: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
    isError,
    structuredContent: data,
  };
}

function plainJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as T;
}

function parseToolInput<T extends z.ZodTypeAny>(schemaValue: T, args: unknown) {
  return schemaValue.parse(args ?? {});
}

function agentPromptFromObjective(prompt: string) {
  return [
    "You are a Summon workspace agent for non-technical team members.",
    "Use connected tools carefully, explain proposed actions clearly, and request approval for protected changes.",
    SUMMON_MEMORY_SYSTEM_INSTRUCTION,
    "",
    `User objective: ${prompt}`,
  ].join("\n");
}

function appUrl(path: string) {
  const base =
    getEnv("APP_URL") ??
    getEnv("NEXT_PUBLIC_APP_URL") ??
    "https://summon-agent-platform.vercel.app";
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${normalizedBase}${normalizedPath}`;
}

function deriveAutomationName(taskBrief: string) {
  const firstLine = taskBrief
    .replace(/\s+/g, " ")
    .trim()
    .split(/[.!?]/)[0]
    ?.trim();
  const candidate = firstLine || "Recurring team automation";

  return candidate.length > 80 ? `${candidate.slice(0, 77).trimEnd()}...` : candidate;
}

function automationPromptFromBrief(input: {
  audience?: string;
  desiredOutcome?: string;
  sharingNotes?: string;
  successCriteria?: string;
  taskBrief: string;
}) {
  const lines = [
    "You are an Agent Platform automation for a shared team workspace.",
    "Your job is to perform a recurring workflow that the user previously handled manually with Claude.",
    "Produce results that teammates can inspect in Agent Platform run history. Be explicit about evidence, blockers, and next actions.",
    "If required source material, credentials, or permissions are missing, report the blocker clearly instead of guessing.",
    "Do not mutate existing external systems, budgets, campaigns, source documents, or send outbound messages unless the platform grants permission or an approval has been granted.",
    SUMMON_MEMORY_SYSTEM_INSTRUCTION,
    "",
    "Recurring task brief:",
    input.taskBrief,
  ];

  if (input.desiredOutcome) {
    lines.push("", "Desired outcome:", input.desiredOutcome);
  }
  if (input.successCriteria) {
    lines.push("", "Success criteria:", input.successCriteria);
  }
  if (input.audience) {
    lines.push("", "Audience / reviewers:", input.audience);
  }
  if (input.sharingNotes) {
    lines.push("", "Sharing and review notes:", input.sharingNotes);
  }

  lines.push(
    "",
    "Every run should finish with:",
    "- a concise team-readable summary",
    "- evidence and citations when source records are available",
    "- generated artifact or destination links when files are created",
    "- blockers and approval needs when the automation cannot safely complete",
  );

  return lines.join("\n");
}

function requireCanCreate(context: McpUserContext) {
  if (!canCreateAgent(context.role)) {
    throw new Error("The authorized Summon user cannot create or edit agents in this workspace.");
  }
}

function requireCanManage(context: McpUserContext) {
  if (!canManageWorkspace(context.role)) {
    throw new Error("The authorized Summon user cannot review approvals in this workspace.");
  }
}

async function contextForArgs(context: McpUserContext, workspaceId?: string) {
  if (!workspaceId || workspaceId === context.workspace.id) {
    return context;
  }

  const selected = context.workspaces.find((item) => item.workspace.id === workspaceId);
  if (!selected) {
    throw new Error("The authorized Summon user does not have access to that workspace.");
  }

  return {
    ...context,
    role: selected.role,
    workspace: selected.workspace,
  } satisfies McpUserContext;
}

function buildTriggerConfig(input: {
  agentId?: string;
  schedule?: z.infer<typeof scheduleSchema>;
  triggerType?: TriggerType;
}) {
  const triggerType: TriggerType =
    input.triggerType ?? (input.schedule ? "SCHEDULED" : "MANUAL");

  if (triggerType !== "SCHEDULED") {
    return { triggerType, triggerConfig: undefined };
  }

  const schedule = buildScheduleConfig({
    agentId: input.agentId,
    frequency: input.schedule?.frequency ?? "DAILY",
    minute: input.schedule?.minute,
    timeOfDay: input.schedule?.time_of_day,
    timezone: input.schedule?.timezone,
    weekday: input.schedule?.weekday,
  });

  return {
    triggerType,
    triggerConfig: schedule as unknown as Prisma.InputJsonObject,
  };
}

function summarizeAgent(agent: {
  actionPermissionMode: string;
  createdAt: Date;
  description: string | null;
  id: string;
  llmModel: string;
  llmProvider: string;
  name: string;
  status: string;
  tools: Prisma.JsonValue;
  triggerConfig: Prisma.JsonValue | null;
  triggerType: string;
  updatedAt: Date;
}) {
  return plainJson({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    triggerType: agent.triggerType,
    triggerConfig: agent.triggerConfig,
    llmProvider: agent.llmProvider,
    llmModel: agent.llmModel,
    actionPermissionMode: agent.actionPermissionMode,
    tools: agent.tools,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  });
}

async function getAgentForWorkspace(agentId: string, workspaceId: string) {
  const agent = await getDb().agent.findFirst({
    where: {
      id: agentId,
      status: { not: "DELETED" },
      workspaceId,
    },
  });

  if (!agent) {
    throw new Error("Agent not found in the authorized workspace.");
  }

  return agent;
}

async function syncActiveAgentSchedule(agentId: string) {
  const agent = await getDb().agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    return;
  }

  if (agent.status === "ACTIVE" && agent.triggerType === "SCHEDULED") {
    await registerAgentScheduler(agent);
  } else {
    await removeAgentScheduler(agent.id);
  }
}

async function getRunDetail(runId: string, workspaceId: string) {
  const run = await getDb().agentRun.findFirst({
    where: {
      id: runId,
      agent: { workspaceId },
    },
    include: {
      agent: { select: { id: true, name: true, workspaceId: true } },
      approvalRequests: {
        orderBy: { createdAt: "desc" },
      },
      artifacts: {
        orderBy: { createdAt: "desc" },
      },
      toolCalls: {
        orderBy: { loggedAt: "asc" },
      },
    },
  });

  if (!run) {
    throw new Error("Run not found in the authorized workspace.");
  }

  return plainJson({
    id: run.id,
    agent: run.agent,
    triggerType: run.triggerType,
    status: run.status,
    summary: run.summary,
    output: run.output,
    error: run.error,
    durationMs: run.durationMs,
    costEstimate: run.costEstimate,
    triggeredAt: run.triggeredAt,
    completedAt: run.completedAt,
    toolCalls: run.toolCalls,
    artifacts: run.artifacts,
    approvals: run.approvalRequests,
    appUrl: `/app/runs/${run.id}?workspace=${workspaceId}`,
  });
}

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.InputJsonObject)
    : {};
}

async function reviewApproval(input: {
  approvalId: string;
  context: McpUserContext;
  status: ApprovalStatus;
}) {
  requireCanManage(input.context);

  const db = getDb();
  const approval = await db.approvalRequest.findFirst({
    where: {
      id: input.approvalId,
      status: "PENDING",
      workspaceId: input.context.workspace.id,
    },
    include: {
      agentRun: { select: { id: true, output: true } },
    },
  });

  if (!approval) {
    throw new Error("Approval request not found or already reviewed.");
  }

  const reviewedAt = new Date();
  const decisionMessage =
    input.status === "APPROVED"
      ? "Approved from the Summon MCP connector. Future mutation tools must check this approval before changing external systems."
      : "Rejected from the Summon MCP connector. No external write was executed.";

  await db.$transaction(async (tx) => {
    const reviewed = await tx.approvalRequest.updateMany({
      where: {
        id: approval.id,
        status: "PENDING",
        workspaceId: input.context.workspace.id,
      },
      data: {
        reviewedAt,
        reviewedById: input.context.user.id,
        status: input.status,
      },
    });

    if (reviewed.count !== 1) {
      throw new Error("Approval request has already been reviewed.");
    }

    if (approval.agentRun) {
      await tx.agentRun.update({
        where: { id: approval.agentRun.id },
        data: {
          output: {
            ...asJsonObject(approval.agentRun.output),
            approvalDecision: {
              approvalRequestId: approval.id,
              message: decisionMessage,
              reviewedAt: reviewedAt.toISOString(),
              reviewedById: input.context.user.id,
              source: "mcp",
              status: input.status,
            },
          },
          summary:
            input.status === "APPROVED"
              ? "Protected action approved through MCP."
              : "Protected action rejected through MCP.",
        },
      });
    }
  });

  if (input.status === "APPROVED") {
    await enqueueApprovedAction({
      kind: "approved-action",
      approvalRequestId: approval.id,
      agentRunId: approval.agentRunId,
      reviewedById: input.context.user.id,
      workspaceId: input.context.workspace.id,
    });
  }

  return getDb().approvalRequest.findUnique({ where: { id: approval.id } });
}

const TOOL_HANDLERS = {
  async summon_get_context(args: unknown, context: McpUserContext) {
    const input = parseToolInput(z.object(workspaceIdSchema), args);
    const selected = await contextForArgs(context, input.workspace_id);
    return textResult({
      user: {
        id: selected.user.id,
        email: selected.user.email,
        name: selected.user.name,
      },
      workspace: {
        ...selected.workspace,
        role: selected.role,
      },
      workspaces: selected.workspaces,
      availableAgentToolKeys: [
        ...connectorCatalog.map((connector) => connector.key),
        ...GENERIC_AGENT_TOOLS.map((tool) => tool.key),
      ],
      workflow:
        "Create agents as drafts, attach references, run a manual test, inspect the run, then activate scheduled agents only when the output is acceptable.",
    });
  },

  async summon_health_check(args: unknown, context: McpUserContext) {
    const input = parseToolInput(z.object(workspaceIdSchema), args);
    const selected = await contextForArgs(context, input.workspace_id);
    const readiness = await getWorkspaceReadiness(selected.workspace.id);
    return textResult({
      workspace: selected.workspace,
      role: selected.role,
      readiness,
    });
  },

  async summon_list_connectors(args: unknown, context: McpUserContext) {
    const input = parseToolInput(z.object(workspaceIdSchema), args);
    const selected = await contextForArgs(context, input.workspace_id);
    const credentials = await getDb().connectorCredential.findMany({
      where: { workspaceId: selected.workspace.id },
      select: {
        connectorType: true,
        displayName: true,
        lastHealthCheckAt: true,
        sharedWithWorkspace: true,
        status: true,
        updatedAt: true,
      },
    });
    const credentialByType = new Map(
      credentials.map((credential) => [credential.connectorType, credential]),
    );

    return textResult({
      workspace: selected.workspace,
      connectors: connectorCatalog.map((connector) => ({
        ...connector,
        credential: credentialByType.get(connector.key) ?? null,
        connected: credentialByType.get(connector.key)?.status === "ACTIVE",
      })),
    });
  },

  async summon_list_agents(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ERROR"]).optional(),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    const agents = await getDb().agent.findMany({
      where: {
        status: input.status ?? { not: "DELETED" },
        workspaceId: selected.workspace.id,
      },
      include: {
        runs: {
          orderBy: { triggeredAt: "desc" },
          select: {
            completedAt: true,
            id: true,
            status: true,
            summary: true,
            triggeredAt: true,
          },
          take: 1,
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    return textResult({
      workspace: selected.workspace,
      agents: agents.map((agent) => ({
        ...summarizeAgent(agent),
        latestRun: agent.runs[0] ?? null,
      })),
    });
  },

  async summon_get_agent(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        agent_id: z.string().min(1),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    const agent = await getDb().agent.findFirst({
      where: {
        id: input.agent_id,
        status: { not: "DELETED" },
        workspaceId: selected.workspace.id,
      },
      include: {
        approvalRequests: {
          where: { status: "PENDING" },
          select: { id: true, requestedAction: true, riskLevel: true, status: true },
        },
        files: { orderBy: { createdAt: "desc" } },
        runs: {
          orderBy: { triggeredAt: "desc" },
          select: {
            completedAt: true,
            costEstimate: true,
            error: true,
            id: true,
            status: true,
            summary: true,
            triggeredAt: true,
          },
          take: 10,
        },
      },
    });

    if (!agent) {
      throw new Error("Agent not found in the authorized workspace.");
    }

    return textResult({
      workspace: selected.workspace,
      agent: plainJson({
        ...summarizeAgent(agent),
        files: agent.files,
        recentRuns: agent.runs,
        pendingApprovals: agent.approvalRequests,
      }),
    });
  },

  async summon_create_agent(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        action_permission_mode: actionPermissionModeSchema,
        delivery_permission_mode: deliveryPermissionModeSchema,
        description: z.string().optional(),
        llm_model: z.string().optional(),
        llm_provider: llmProviderSchema.optional(),
        name: z.string().min(1),
        prompt: z.string().optional(),
        schedule: scheduleSchema,
        status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]).default("DRAFT"),
        system_prompt: z.string().optional(),
        tools: z.array(z.string()).optional(),
        trigger_type: z.enum(["MANUAL", "SCHEDULED"]).optional(),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);

    const defaults = getDefaultLlmSettings();
    const trigger = buildTriggerConfig({
      schedule: input.schedule,
      triggerType: input.trigger_type,
    });
    const requestedStatus = input.status;
    const activateScheduled =
      requestedStatus === "ACTIVE" && trigger.triggerType === "SCHEDULED";
    const systemPrompt =
      input.system_prompt ??
      agentPromptFromObjective(
        input.prompt ?? `${input.name}: ${input.description ?? "Workspace automation."}`,
      );

    const agent = await getDb().agent.create({
      data: {
        actionPermissionMode: input.action_permission_mode ?? "ASK_BEFORE_CHANGES",
        createdById: selected.user.id,
        deliveryPermissionMode: input.delivery_permission_mode ?? "ASK_BEFORE_SENDING",
        description: input.description ?? "Agent created through the Summon MCP connector.",
        llmModel: input.llm_model ?? defaults.model,
        llmProvider: input.llm_provider ?? defaults.provider,
        name: input.name,
        status: activateScheduled ? "DRAFT" : requestedStatus,
        systemPrompt,
        tools: normalizeAgentToolSelection(input.tools ?? []) as Prisma.InputJsonArray,
        triggerConfig: trigger.triggerConfig,
        triggerType: trigger.triggerType,
        workspaceId: selected.workspace.id,
      },
    });

    let updatedAgent = agent;
    if (trigger.triggerType === "SCHEDULED") {
      const schedule = withAgentSchedulerId(
        readScheduleConfig(trigger.triggerConfig) ??
          buildScheduleConfig({ agentId: agent.id, frequency: "DAILY" }),
        agent.id,
      );
      updatedAgent = await getDb().agent.update({
        where: { id: agent.id },
        data: {
          triggerConfig: schedule as unknown as Prisma.InputJsonObject,
        },
      });

      if (requestedStatus === "ACTIVE") {
        await registerAgentScheduler({ ...updatedAgent, status: "ACTIVE" });
        updatedAgent = await getDb().agent.update({
          where: { id: agent.id },
          data: { status: "ACTIVE" },
        });
      }
    }

    return textResult({
      agent: summarizeAgent(updatedAgent),
      appUrl: `/app/agents/${updatedAgent.id}?workspace=${selected.workspace.id}`,
      workspace: selected.workspace,
    });
  },

  async summon_create_automation_from_brief(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        action_permission_mode: actionPermissionModeSchema,
        audience: z.string().optional(),
        delivery_permission_mode: deliveryPermissionModeSchema,
        desired_outcome: z.string().optional(),
        name: z.string().optional(),
        references: z.array(agentReferenceSchema).default([]),
        run_test: z.boolean().default(false),
        schedule: scheduleSchema,
        sharing_notes: z.string().optional(),
        status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]).default("DRAFT"),
        success_criteria: z.string().optional(),
        task_brief: z.string().min(1),
        tools: z.array(z.string()).optional(),
        trigger_type: z.enum(["MANUAL", "SCHEDULED"]).optional(),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);

    for (const reference of input.references) {
      if (reference.source_type === "external_url" && !reference.url) {
        throw new Error(`Reference "${reference.name}" needs a url when source_type is external_url.`);
      }
      if (reference.source_type === "uploaded_text" && !reference.content_text) {
        throw new Error(
          `Reference "${reference.name}" needs content_text when source_type is uploaded_text.`,
        );
      }
    }

    const defaults = getDefaultLlmSettings();
    const name = input.name?.trim() || deriveAutomationName(input.task_brief);
    const trigger = buildTriggerConfig({
      schedule: input.schedule,
      triggerType: input.trigger_type,
    });
    const requestedStatus = input.status;
    const activateScheduled =
      requestedStatus === "ACTIVE" && trigger.triggerType === "SCHEDULED";
    const systemPrompt = automationPromptFromBrief({
      audience: input.audience,
      desiredOutcome: input.desired_outcome,
      sharingNotes: input.sharing_notes,
      successCriteria: input.success_criteria,
      taskBrief: input.task_brief,
    });

    const agent = await getDb().agent.create({
      data: {
        actionPermissionMode: input.action_permission_mode ?? "ASK_BEFORE_CHANGES",
        createdById: selected.user.id,
        deliveryPermissionMode: input.delivery_permission_mode ?? "ASK_BEFORE_SENDING",
        description:
          input.desired_outcome ??
          "Team automation created from a Claude/Cowork recurring-task brief.",
        llmModel: defaults.model,
        llmProvider: defaults.provider,
        name,
        status: activateScheduled ? "DRAFT" : requestedStatus,
        systemPrompt,
        tools: normalizeAgentToolSelection(input.tools ?? []) as Prisma.InputJsonArray,
        triggerConfig: trigger.triggerConfig,
        triggerType: trigger.triggerType,
        workspaceId: selected.workspace.id,
      },
    });

    let updatedAgent = agent;
    if (trigger.triggerType === "SCHEDULED") {
      const schedule = withAgentSchedulerId(
        readScheduleConfig(trigger.triggerConfig) ??
          buildScheduleConfig({ agentId: agent.id, frequency: "DAILY" }),
        agent.id,
      );
      updatedAgent = await getDb().agent.update({
        where: { id: agent.id },
        data: {
          triggerConfig: schedule as unknown as Prisma.InputJsonObject,
        },
      });

      if (requestedStatus === "ACTIVE") {
        await registerAgentScheduler({ ...updatedAgent, status: "ACTIVE" });
        updatedAgent = await getDb().agent.update({
          where: { id: agent.id },
          data: { status: "ACTIVE" },
        });
      }
    }

    const files = [];
    for (const reference of input.references) {
      files.push(
        await createAgentFile({
          agentId: updatedAgent.id,
          contentText: reference.content_text,
          description: reference.description,
          metadata: {
            addedFrom: "mcp_automation_brief",
            tokenId: context.accessTokenId,
          },
          mimeType:
            reference.mime_type ??
            (reference.source_type === "uploaded_text" ? "text/plain" : undefined),
          name: reference.name,
          role: reference.role,
          sizeBytes: reference.content_text
            ? Buffer.byteLength(reference.content_text, "utf8")
            : undefined,
          sourceType: reference.source_type,
          url: reference.url,
          workspaceId: selected.workspace.id,
        }),
      );
    }

    const run = input.run_test
      ? await createManualAgentRun({
          agentId: updatedAgent.id,
          triggeredById: selected.user.id,
          workspaceId: selected.workspace.id,
        })
      : null;

    return textResult({
      automation: summarizeAgent(updatedAgent),
      automationUrl: appUrl(
        `/app/agents/${updatedAgent.id}?workspace=${selected.workspace.id}`,
      ),
      attachedReferences: plainJson(files),
      nextSteps: [
        run
          ? "Open the test run, review the result, and ask Claude to adjust the automation if anything is wrong."
          : "Run a manual test before activating a schedule.",
        updatedAgent.status === "ACTIVE"
          ? "The automation is active. Scheduled runs will appear in Agent Platform run history."
          : "Keep it as a draft until the team approves the test result, then activate it.",
        "Team members with workspace access can see the automation, runs, artifacts, and approvals in Agent Platform.",
      ],
      run: run ? plainJson(run) : null,
      runUrl: run ? appUrl(`/app/runs/${run.id}?workspace=${selected.workspace.id}`) : null,
      workspace: selected.workspace,
    });
  },

  async summon_update_agent(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        action_permission_mode: actionPermissionModeSchema,
        agent_id: z.string().min(1),
        delivery_permission_mode: deliveryPermissionModeSchema,
        description: z.string().optional(),
        llm_model: z.string().optional(),
        llm_provider: llmProviderSchema.optional(),
        name: z.string().optional(),
        prompt: z.string().optional(),
        schedule: scheduleSchema,
        system_prompt: z.string().optional(),
        tools: z.array(z.string()).optional(),
        trigger_type: z.enum(["MANUAL", "SCHEDULED"]).optional(),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);
    const existing = await getAgentForWorkspace(input.agent_id, selected.workspace.id);
    const trigger =
      input.trigger_type || input.schedule
        ? buildTriggerConfig({
            agentId: existing.id,
            schedule: input.schedule,
            triggerType: input.trigger_type,
          })
        : null;

    const updatedAgent = await getDb().agent.update({
      where: { id: existing.id },
      data: {
        actionPermissionMode: input.action_permission_mode ?? existing.actionPermissionMode,
        deliveryPermissionMode:
          input.delivery_permission_mode ?? existing.deliveryPermissionMode,
        description: input.description ?? existing.description,
        llmModel: input.llm_model ?? existing.llmModel,
        llmProvider: input.llm_provider ?? existing.llmProvider,
        name: input.name ?? existing.name,
        systemPrompt: input.system_prompt
          ? input.system_prompt
          : input.prompt
            ? agentPromptFromObjective(input.prompt)
            : existing.systemPrompt,
        tools:
          input.tools !== undefined
            ? (normalizeAgentToolSelection(input.tools) as Prisma.InputJsonArray)
            : (existing.tools as Prisma.InputJsonValue),
        triggerConfig: trigger?.triggerConfig ?? existing.triggerConfig ?? Prisma.DbNull,
        triggerType: trigger?.triggerType ?? existing.triggerType,
      },
    });

    await syncActiveAgentSchedule(updatedAgent.id);

    return textResult({
      agent: summarizeAgent(updatedAgent),
      appUrl: `/app/agents/${updatedAgent.id}?workspace=${selected.workspace.id}`,
      workspace: selected.workspace,
    });
  },

  async summon_activate_agent(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({ ...workspaceIdSchema, agent_id: z.string().min(1) }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);
    const agent = await getAgentForWorkspace(input.agent_id, selected.workspace.id);

    let triggerConfig: Prisma.InputJsonValue | undefined;
    if (agent.triggerType === "SCHEDULED") {
      const schedule =
        readScheduleConfig(agent.triggerConfig) ??
        buildScheduleConfig({ agentId: agent.id, frequency: "DAILY" });
      triggerConfig = withAgentSchedulerId(
        schedule,
        agent.id,
      ) as unknown as Prisma.InputJsonObject;
      await registerAgentScheduler({
        ...agent,
        status: "ACTIVE",
        triggerConfig: triggerConfig as Prisma.JsonValue,
      });
    } else {
      await removeAgentScheduler(agent.id);
    }

    const updatedAgent = await getDb().agent.update({
      where: { id: agent.id },
      data: {
        status: "ACTIVE",
        triggerConfig:
          agent.triggerType === "SCHEDULED"
            ? triggerConfig
            : agent.triggerConfig ?? undefined,
      },
    });

    return textResult({
      agent: summarizeAgent(updatedAgent),
      workspace: selected.workspace,
    });
  },

  async summon_pause_agent(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({ ...workspaceIdSchema, agent_id: z.string().min(1) }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);
    const agent = await getAgentForWorkspace(input.agent_id, selected.workspace.id);
    await removeAgentScheduler(agent.id);
    const updatedAgent = await getDb().agent.update({
      where: { id: agent.id },
      data: { status: "PAUSED" },
    });

    return textResult({
      agent: summarizeAgent(updatedAgent),
      workspace: selected.workspace,
    });
  },

  async summon_delete_agent(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({ ...workspaceIdSchema, agent_id: z.string().min(1) }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);
    const agent = await getAgentForWorkspace(input.agent_id, selected.workspace.id);
    await removeAgentScheduler(agent.id);
    const updatedAgent = await getDb().agent.update({
      where: { id: agent.id },
      data: { status: "DELETED" },
    });

    return textResult({
      agent: summarizeAgent(updatedAgent),
      deleted: true,
      workspace: selected.workspace,
    });
  },

  async summon_add_agent_file(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        agent_id: z.string().min(1),
        content_text: z.string().optional(),
        description: z.string().optional(),
        mime_type: z.string().optional(),
        name: z.string().min(1),
        role: z
          .enum(["input_data", "helper_code", "template", "reference", "output_destination", "other"])
          .default("reference"),
        source_type: z.enum(["external_url", "uploaded_text"]).default("external_url"),
        url: z.string().optional(),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);
    await getAgentForWorkspace(input.agent_id, selected.workspace.id);

    if (input.source_type === "external_url" && !input.url) {
      throw new Error("url is required when source_type is external_url.");
    }
    if (input.source_type === "uploaded_text" && !input.content_text) {
      throw new Error("content_text is required when source_type is uploaded_text.");
    }

    const file = await createAgentFile({
      agentId: input.agent_id,
      contentText: input.content_text,
      description: input.description,
      metadata: { addedFrom: "mcp", tokenId: context.accessTokenId },
      mimeType: input.mime_type ?? (input.source_type === "uploaded_text" ? "text/plain" : undefined),
      name: input.name,
      role: input.role,
      sizeBytes: input.content_text ? Buffer.byteLength(input.content_text, "utf8") : undefined,
      sourceType: input.source_type,
      url: input.url,
      workspaceId: selected.workspace.id,
    });

    return textResult({
      file: plainJson(file),
      workspace: selected.workspace,
    });
  },

  async summon_remove_agent_file(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        agent_id: z.string().min(1),
        file_id: z.string().min(1),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    requireCanCreate(selected);
    const deleted = await getDb().agentFile.deleteMany({
      where: {
        agentId: input.agent_id,
        id: input.file_id,
        workspaceId: selected.workspace.id,
      },
    });

    return textResult({
      deletedCount: deleted.count,
      workspace: selected.workspace,
    });
  },

  async summon_run_agent(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({ ...workspaceIdSchema, agent_id: z.string().min(1) }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    const run = await createManualAgentRun({
      agentId: input.agent_id,
      triggeredById: selected.user.id,
      workspaceId: selected.workspace.id,
    });

    return textResult({
      run: plainJson(run),
      appUrl: `/app/runs/${run.id}?workspace=${selected.workspace.id}`,
      workspace: selected.workspace,
    });
  },

  async summon_get_run(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({ ...workspaceIdSchema, run_id: z.string().min(1) }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    return textResult({
      run: await getRunDetail(input.run_id, selected.workspace.id),
      workspace: selected.workspace,
    });
  },

  async summon_wait_for_run(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        max_seconds: z.number().min(1).max(25).default(20),
        run_id: z.string().min(1),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    const deadline = Date.now() + input.max_seconds * 1000;
    let detail = await getRunDetail(input.run_id, selected.workspace.id);

    while (
      ["QUEUED", "RUNNING"].includes(String(detail.status)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      detail = await getRunDetail(input.run_id, selected.workspace.id);
    }

    return textResult({
      run: detail,
      workspace: selected.workspace,
    });
  },

  async summon_list_approvals(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        status: z
          .enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "ALL"])
          .default("PENDING"),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    const approvals = await getDb().approvalRequest.findMany({
      where: {
        status: input.status === "ALL" ? undefined : input.status,
        workspaceId: selected.workspace.id,
      },
      include: {
        agent: { select: { id: true, name: true } },
        agentRun: { select: { id: true, status: true, summary: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return textResult({
      approvals: plainJson(approvals),
      workspace: selected.workspace,
    });
  },

  async summon_review_approval(args: unknown, context: McpUserContext) {
    const input = parseToolInput(
      z.object({
        ...workspaceIdSchema,
        approval_id: z.string().min(1),
        status: z.enum(["APPROVED", "REJECTED"]),
      }),
      args,
    );
    const selected = await contextForArgs(context, input.workspace_id);
    const approval = await reviewApproval({
      approvalId: input.approval_id,
      context: selected,
      status: input.status,
    });

    return textResult({
      approval: plainJson(approval),
      workspace: selected.workspace,
    });
  },
} satisfies Record<
  (typeof MCP_TOOLS)[number]["name"],
  (args: unknown, context: McpUserContext) => Promise<ToolResult>
>;

export async function callMcpTool({
  arguments: args,
  context,
  name,
}: {
  arguments: unknown;
  context: McpUserContext;
  name: string;
}) {
  const handler = TOOL_HANDLERS[name as keyof typeof TOOL_HANDLERS];
  if (!handler) {
    throw new Error(`Unknown Summon MCP tool: ${name}`);
  }

  try {
    return await handler(args, context);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Invalid tool input: ${error.issues.map((issue) => `${issue.path.join(".") || "root"} ${issue.message}`).join("; ")}`
        : error instanceof Error
          ? error.message
          : "Summon MCP tool failed.";

    return textResult({ error: message, tool: name }, true);
  }
}

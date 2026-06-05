"use server";

import {
  Prisma,
  type ActionPermissionMode,
  type ApprovalStatus,
  type DeliveryPermissionMode,
  type MembershipRole,
  type TriggerType,
} from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createManualAgentRun } from "@/lib/agents/runs";
import {
  registerAgentScheduler,
  removeAgentScheduler,
} from "@/lib/agents/scheduler";
import {
  buildScheduleConfig,
  readScheduleConfig,
  withAgentSchedulerId,
} from "@/lib/agents/schedules";
import {
  canCreateAgent,
  canManageWorkspace,
  getCurrentUserContext,
} from "@/lib/app/context";
import { titleFromPrompt } from "@/lib/app/format";
import {
  createOrRefreshWorkspaceInvitation,
  normalizeInviteEmail,
} from "@/lib/app/invitations";
import { createWorkspaceWithOwnerMembership } from "@/lib/app/workspaces";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { getDb } from "@/lib/db";
import { llmProviderSchema } from "@/lib/env";

function requireContext(workspaceId?: string) {
  return getCurrentUserContext(workspaceId).then((context) => {
    if (!context.isAuthenticated) {
      throw new Error("You must be signed in.");
    }

    return context;
  });
}

function getText(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asJsonObject(value: unknown): Prisma.InputJsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.InputJsonObject)
    : {};
}

function selectedConnectorTools(formData: FormData) {
  const selectedConnectors = formData
    .getAll("tools")
    .filter((value): value is string => typeof value === "string");

  return selectedConnectors.length > 0
    ? selectedConnectors
    : connectorCatalog.slice(0, 2).map((connector) => connector.key);
}

function triggerConfigFromFormData(formData: FormData, agentId?: string) {
  const triggerInput = getText(formData, "triggerType", "MANUAL");
  const triggerType: TriggerType =
    triggerInput === "SCHEDULED" ? "SCHEDULED" : "MANUAL";

  if (triggerType !== "SCHEDULED") {
    return {
      triggerType,
      triggerConfig: undefined,
    };
  }

  const schedule = buildScheduleConfig({
    frequency: getText(formData, "scheduleFrequency", "DAILY"),
    timezone: getText(formData, "scheduleTimezone", "Europe/London"),
    minute: getText(formData, "scheduleMinute", "0"),
    timeOfDay: getText(formData, "scheduleTimeOfDay", "09:00"),
    weekday: getText(formData, "scheduleWeekday", "1"),
    agentId,
  });

  return {
    triggerType,
    triggerConfig: schedule as unknown as Prisma.InputJsonObject,
  };
}

function agentPromptFromForm(prompt: string) {
  return [
    "You are a Summon workspace agent for non-technical team members.",
    "Use connected tools carefully, explain proposed actions clearly, and request approval for protected changes.",
    "",
    `User objective: ${prompt}`,
  ].join("\n");
}

function redirectToWorkspaces(
  workspaceId: string,
  params: Record<string, string>,
): never {
  const searchParams = new URLSearchParams({
    workspace: workspaceId,
    ...params,
  });

  redirect(`/app/workspaces?${searchParams.toString()}`);
}

export async function createSharedWorkspace(formData: FormData) {
  const context = await requireContext();
  const name = getText(formData, "name", "Summon shared workspace");

  const workspace = await createWorkspaceWithOwnerMembership({
    name,
    slugBase: name,
    type: "SHARED",
    ownerId: context.user.id,
  });

  revalidatePath("/app", "layout");
  redirect(`/app?workspace=${workspace.id}`);
}

export async function inviteWorkspaceMember(formData: FormData) {
  const workspaceId = getText(formData, "workspaceId");
  const email = normalizeInviteEmail(getText(formData, "email"));
  const role = getText(formData, "role", "CREATOR") as MembershipRole;
  const context = await requireContext(workspaceId);

  if (!canManageWorkspace(context.role)) {
    redirectToWorkspaces(context.workspace.id, { inviteError: "permission" });
  }

  if (context.workspace.type !== "SHARED") {
    redirectToWorkspaces(context.workspace.id, { inviteError: "shared-required" });
  }

  if (!email.includes("@")) {
    redirectToWorkspaces(context.workspace.id, { inviteError: "invalid-email" });
  }

  if (!["ADMIN", "CREATOR", "VIEWER"].includes(role)) {
    redirectToWorkspaces(context.workspace.id, { inviteError: "invalid-role" });
  }

  const db = getDb();
  const invitedUser = await db.user.findFirst({
    where: {
      email: {
        equals: email,
        mode: "insensitive",
      },
    },
  });

  if (invitedUser?.id === context.user.id) {
    redirectToWorkspaces(context.workspace.id, { inviteError: "self" });
  }

  const existingMembership = invitedUser
    ? await db.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: context.workspace.id,
            userId: invitedUser.id,
          },
        },
      })
    : null;

  if (existingMembership?.role === "OWNER") {
    redirectToWorkspaces(context.workspace.id, { inviteError: "owner" });
  }

  if (existingMembership?.status === "ACTIVE") {
    await db.workspaceMembership.update({
      where: { id: existingMembership.id },
      data: {
        invitedById: context.user.id,
        role,
      },
    });
    revalidatePath("/app", "layout");
    redirectToWorkspaces(context.workspace.id, { inviteStatus: "updated" });
  }

  const invitation = await createOrRefreshWorkspaceInvitation({
    email,
    invitedBy: context.user,
    role,
    workspaceId: context.workspace.id,
  });

  revalidatePath("/app", "layout");
  redirectToWorkspaces(
    context.workspace.id,
    invitation.deliveryStatus.sent
      ? { inviteStatus: "sent" }
      : { inviteLink: invitation.inviteUrl, inviteStatus: "manual" },
  );
}

export async function resendWorkspaceInvitation(formData: FormData) {
  const workspaceId = getText(formData, "workspaceId");
  const invitationId = getText(formData, "invitationId");
  const context = await requireContext(workspaceId);

  if (!canManageWorkspace(context.role)) {
    redirectToWorkspaces(context.workspace.id, { inviteError: "permission" });
  }

  const invitation = await getDb().workspaceInvitation.findFirst({
    where: {
      id: invitationId,
      workspaceId: context.workspace.id,
      status: "PENDING",
    },
  });

  if (!invitation) {
    redirectToWorkspaces(context.workspace.id, { inviteError: "missing-invite" });
  }

  const refreshedInvitation = await createOrRefreshWorkspaceInvitation({
    email: invitation.email,
    invitedBy: context.user,
    role: invitation.role,
    workspaceId: context.workspace.id,
  });

  revalidatePath("/app", "layout");
  redirectToWorkspaces(
    context.workspace.id,
    refreshedInvitation.deliveryStatus.sent
      ? { inviteStatus: "resent" }
      : {
          inviteLink: refreshedInvitation.inviteUrl,
          inviteStatus: "manual",
        },
  );
}

export async function revokeWorkspaceInvitation(formData: FormData) {
  const workspaceId = getText(formData, "workspaceId");
  const invitationId = getText(formData, "invitationId");
  const context = await requireContext(workspaceId);

  if (!canManageWorkspace(context.role)) {
    redirectToWorkspaces(context.workspace.id, { inviteError: "permission" });
  }

  await getDb().workspaceInvitation.updateMany({
    where: {
      id: invitationId,
      workspaceId: context.workspace.id,
      status: "PENDING",
    },
    data: {
      status: "REVOKED",
      tokenHash: null,
    },
  });

  revalidatePath("/app", "layout");
  redirectToWorkspaces(context.workspace.id, { inviteStatus: "revoked" });
}

export async function createAgentDraft(formData: FormData) {
  const workspaceId = getText(formData, "workspaceId");
  const context = await requireContext(workspaceId);

  if (!canCreateAgent(context.role)) {
    throw new Error("You do not have permission to create agents.");
  }

  const prompt = getText(formData, "prompt");
  if (!prompt) {
    throw new Error("Agent prompt is required.");
  }

  const providerInput = getText(formData, "llmProvider", "openai");
  const llmProvider = llmProviderSchema.parse(providerInput);
  const llmModel = getText(formData, "llmModel", "gpt-4.1");
  const intent = getText(formData, "intent", "draft");
  const requestedStatus = intent === "activate" ? "ACTIVE" : "DRAFT";
  const actionPermissionMode = getText(
    formData,
    "actionPermissionMode",
    "ASK_BEFORE_CHANGES",
  ) as ActionPermissionMode;
  const deliveryPermissionMode = getText(
    formData,
    "deliveryPermissionMode",
    "ASK_BEFORE_SENDING",
  ) as DeliveryPermissionMode;
  const connectorTools = selectedConnectorTools(formData);
  const trigger = triggerConfigFromFormData(formData);
  const activateScheduledAgent =
    requestedStatus === "ACTIVE" && trigger.triggerType === "SCHEDULED";

  const agent = await getDb().agent.create({
    data: {
      workspaceId: context.workspace.id,
      name: getText(formData, "name", titleFromPrompt(prompt)),
      description: getText(
        formData,
        "description",
        "Draft agent created from a plain-English prompt.",
      ),
      systemPrompt: agentPromptFromForm(prompt),
      tools: connectorTools,
      triggerType: trigger.triggerType,
      triggerConfig: trigger.triggerConfig ?? undefined,
      status: activateScheduledAgent ? "DRAFT" : requestedStatus,
      llmProvider,
      llmModel,
      actionPermissionMode,
      deliveryPermissionMode,
      createdById: context.user.id,
    },
  });

  if (trigger.triggerType === "SCHEDULED" && trigger.triggerConfig) {
    const schedule = withAgentSchedulerId(
      readScheduleConfig(trigger.triggerConfig) ?? buildScheduleConfig({ frequency: "DAILY" }),
      agent.id,
    );
    const updatedAgent = await getDb().agent.update({
      where: { id: agent.id },
      data: {
        triggerConfig: schedule as unknown as Prisma.InputJsonObject,
      },
    });

    if (requestedStatus === "ACTIVE") {
      await registerAgentScheduler({
        ...updatedAgent,
        status: "ACTIVE",
      });
      await getDb().agent.update({
        where: { id: agent.id },
        data: { status: "ACTIVE" },
      });
    }
  }

  revalidatePath("/app", "layout");
  redirect(`/app/agents/${agent.id}?workspace=${context.workspace.id}`);
}

export async function createAgentAndMaybeActivate(formData: FormData) {
  return createAgentDraft(formData);
}

export async function activateAgent(formData: FormData) {
  const agentId = getText(formData, "agentId");
  const workspaceId = getText(formData, "workspaceId");
  const context = await requireContext(workspaceId);

  if (!canCreateAgent(context.role)) {
    throw new Error("You do not have permission to activate agents.");
  }

  const agent = await getDb().agent.findFirst({
    where: {
      id: agentId,
      workspaceId: context.workspace.id,
      status: { not: "DELETED" },
    },
  });

  if (!agent) {
    throw new Error("Agent not found.");
  }

  let triggerConfig: Prisma.InputJsonValue | undefined;
  if (agent.triggerType === "SCHEDULED") {
    const schedule =
      readScheduleConfig(agent.triggerConfig) ??
      buildScheduleConfig({ frequency: "DAILY", agentId: agent.id });
    triggerConfig = withAgentSchedulerId(
      schedule,
      agent.id,
    ) as unknown as Prisma.InputJsonObject;
  }

  if (agent.triggerType === "SCHEDULED") {
    await registerAgentScheduler({
      ...agent,
      status: "ACTIVE",
      triggerConfig:
        (triggerConfig as unknown as Prisma.JsonValue | undefined) ??
        agent.triggerConfig,
    });
  } else {
    await removeAgentScheduler(agent.id);
  }

  await getDb().agent.update({
    where: { id: agent.id },
    data: {
      status: "ACTIVE",
      triggerConfig:
        agent.triggerType === "SCHEDULED"
          ? triggerConfig
          : agent.triggerConfig ?? undefined,
    },
  });
  revalidatePath("/app", "layout");
  redirect(`/app/agents/${agent.id}?workspace=${context.workspace.id}`);
}

export async function pauseAgent(formData: FormData) {
  const agentId = getText(formData, "agentId");
  const workspaceId = getText(formData, "workspaceId");
  const context = await requireContext(workspaceId);

  if (!canCreateAgent(context.role)) {
    throw new Error("You do not have permission to pause agents.");
  }

  const agent = await getDb().agent.findFirst({
    where: {
      id: agentId,
      workspaceId: context.workspace.id,
      status: { not: "DELETED" },
    },
  });

  if (!agent) {
    throw new Error("Agent not found.");
  }

  await removeAgentScheduler(agent.id);

  const updatedAgent = await getDb().agent.update({
    where: { id: agent.id },
    data: { status: "PAUSED" },
  });

  revalidatePath("/app", "layout");
  redirect(`/app/agents/${updatedAgent.id}?workspace=${context.workspace.id}`);
}

export async function updateAgentConfig(formData: FormData) {
  const agentId = getText(formData, "agentId");
  const workspaceId = getText(formData, "workspaceId");
  const context = await requireContext(workspaceId);

  if (!canCreateAgent(context.role)) {
    throw new Error("You do not have permission to edit agents.");
  }

  const existingAgent = await getDb().agent.findFirst({
    where: {
      id: agentId,
      workspaceId: context.workspace.id,
      status: { not: "DELETED" },
    },
  });

  if (!existingAgent) {
    throw new Error("Agent not found.");
  }

  const prompt = getText(formData, "prompt");
  const trigger = triggerConfigFromFormData(formData, existingAgent.id);
  const providerInput = getText(formData, "llmProvider", existingAgent.llmProvider);
  const llmProvider = llmProviderSchema.parse(providerInput);
  const llmModel = getText(formData, "llmModel", existingAgent.llmModel);

  const updateData = {
    name: getText(formData, "name", existingAgent.name),
    description: getText(
      formData,
      "description",
      existingAgent.description ?? "Workspace agent.",
    ),
    systemPrompt: prompt
      ? agentPromptFromForm(prompt)
      : getText(formData, "systemPrompt", existingAgent.systemPrompt),
    tools: selectedConnectorTools(formData),
    triggerType: trigger.triggerType,
    triggerConfig: trigger.triggerConfig ?? Prisma.DbNull,
    llmProvider,
    llmModel,
    actionPermissionMode: getText(
      formData,
      "actionPermissionMode",
      existingAgent.actionPermissionMode,
    ) as ActionPermissionMode,
    deliveryPermissionMode: getText(
      formData,
      "deliveryPermissionMode",
      existingAgent.deliveryPermissionMode,
    ) as DeliveryPermissionMode,
  };

  let schedulerChanged = false;

  try {
    if (existingAgent.status === "ACTIVE") {
      if (trigger.triggerType === "SCHEDULED") {
        await registerAgentScheduler({
          ...existingAgent,
          ...updateData,
          status: "ACTIVE",
          triggerType: "SCHEDULED",
          triggerConfig: trigger.triggerConfig as unknown as Prisma.JsonValue,
        });
      } else {
        await removeAgentScheduler(existingAgent.id);
      }
      schedulerChanged = true;
    }

    const updatedAgent = await getDb().agent.update({
      where: { id: existingAgent.id },
      data: updateData,
    });

    revalidatePath("/app", "layout");
    redirect(`/app/agents/${updatedAgent.id}?workspace=${context.workspace.id}`);
  } catch (error) {
    if (schedulerChanged) {
      await registerAgentScheduler(existingAgent).catch(() => undefined);
    }

    throw error;
  }
}

export async function updateAgentSchedule(formData: FormData) {
  return updateAgentConfig(formData);
}

export async function createManualRun(formData: FormData) {
  const agentId = getText(formData, "agentId");
  const workspaceId = getText(formData, "workspaceId");
  const context = await requireContext(workspaceId);
  const run = await createManualAgentRun({
    agentId,
    workspaceId: context.workspace.id,
    triggeredById: context.user.id,
  });

  revalidatePath("/app", "layout");
  redirect(`/app/runs/${run.id}?workspace=${context.workspace.id}`);
}

export async function updateApprovalStatus(formData: FormData) {
  const approvalId = getText(formData, "approvalId");
  const workspaceId = getText(formData, "workspaceId");
  const status = getText(formData, "status") as ApprovalStatus;
  const context = await requireContext(workspaceId);

  if (!canManageWorkspace(context.role)) {
    throw new Error("You do not have permission to review approvals.");
  }

  if (status !== "APPROVED" && status !== "REJECTED") {
    throw new Error("Invalid approval status.");
  }

  const db = getDb();
  const approval = await db.approvalRequest.findFirst({
    where: {
      id: approvalId,
      workspaceId: context.workspace.id,
      status: "PENDING",
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
    status === "APPROVED"
      ? "Approved. No external write has been executed yet; future mutation tools must check this approval before changing external systems."
      : "Rejected. No external write was executed, and future mutation tools must not use this request.";

  await db.$transaction(async (tx) => {
    const reviewed = await tx.approvalRequest.updateMany({
      where: {
        id: approval.id,
        workspaceId: context.workspace.id,
        status: "PENDING",
      },
      data: {
        status,
        reviewedById: context.user.id,
        reviewedAt,
      },
    });

    if (reviewed.count !== 1) {
      throw new Error("Approval request has already been reviewed.");
    }

    if (approval.agentRun) {
      await tx.agentRun.update({
        where: { id: approval.agentRun.id },
        data: {
          summary:
            status === "APPROVED"
              ? "Protected action approved. No external write was executed."
              : "Protected action rejected. No external write was executed.",
          output: {
            ...asJsonObject(approval.agentRun.output),
            approvalDecision: {
              approvalRequestId: approval.id,
              status,
              reviewedAt: reviewedAt.toISOString(),
              reviewedById: context.user.id,
              message: decisionMessage,
            },
          },
        },
      });
    }
  });

  revalidatePath("/app/approvals");
  revalidatePath("/app/runs");
  if (approval.agentRunId) {
    redirect(`/app/runs/${approval.agentRunId}?workspace=${context.workspace.id}`);
  }
}

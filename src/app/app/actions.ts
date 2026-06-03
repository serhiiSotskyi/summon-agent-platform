"use server";

import type {
  ActionPermissionMode,
  ApprovalStatus,
  DeliveryPermissionMode,
  MembershipRole,
  Prisma,
  TriggerType,
} from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createManualAgentRun } from "@/lib/agents/runs";
import {
  canCreateAgent,
  canManageWorkspace,
  getCurrentUserContext,
} from "@/lib/app/context";
import { titleFromPrompt } from "@/lib/app/format";
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
  const email = getText(formData, "email").toLowerCase();
  const role = getText(formData, "role", "CREATOR") as MembershipRole;
  const context = await requireContext(workspaceId);

  if (!canManageWorkspace(context.role)) {
    throw new Error("You do not have permission to invite workspace members.");
  }

  if (context.workspace.type !== "SHARED") {
    throw new Error("Create or select a shared workspace before inviting members.");
  }

  if (!email.includes("@")) {
    throw new Error("Enter a valid email address.");
  }

  if (!["ADMIN", "CREATOR", "VIEWER"].includes(role)) {
    throw new Error("Invalid workspace role.");
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

  if (!invitedUser) {
    throw new Error(
      "That user has not signed into this app yet. Ask them to sign in once, then invite them again.",
    );
  }

  if (invitedUser.id === context.user.id) {
    throw new Error("You are already a member of this workspace.");
  }

  const existingMembership = await db.workspaceMembership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: context.workspace.id,
        userId: invitedUser.id,
      },
    },
  });

  if (existingMembership?.role === "OWNER") {
    throw new Error("Workspace owners cannot be changed from this invite form.");
  }

  await db.workspaceMembership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: context.workspace.id,
        userId: invitedUser.id,
      },
    },
    create: {
      workspaceId: context.workspace.id,
      userId: invitedUser.id,
      role,
      invitedById: context.user.id,
      status: "ACTIVE",
    },
    update: {
      role,
      invitedById: context.user.id,
      status: "ACTIVE",
    },
  });

  revalidatePath("/app", "layout");
  redirect(`/app/workspaces?workspace=${context.workspace.id}`);
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
  const triggerType = getText(formData, "triggerType", "MANUAL") as TriggerType;
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
  const selectedConnectors = formData
    .getAll("tools")
    .filter((value): value is string => typeof value === "string");
  const connectorTools =
    selectedConnectors.length > 0
      ? selectedConnectors
      : connectorCatalog.slice(0, 2).map((connector) => connector.key);

  const agent = await getDb().agent.create({
    data: {
      workspaceId: context.workspace.id,
      name: getText(formData, "name", titleFromPrompt(prompt)),
      description: getText(
        formData,
        "description",
        "Draft agent created from a plain-English prompt.",
      ),
      systemPrompt: [
        "You are a Summon workspace agent for non-technical team members.",
        "Use connected tools carefully, explain proposed actions clearly, and request approval for protected changes.",
        "",
        `User objective: ${prompt}`,
      ].join("\n"),
      tools: connectorTools,
      triggerType,
      triggerConfig:
        triggerType === "SCHEDULED"
          ? { schedule: getText(formData, "schedule", "Every Monday at 9am") }
          : undefined,
      status: "DRAFT",
      llmProvider,
      llmModel,
      actionPermissionMode,
      deliveryPermissionMode,
      createdById: context.user.id,
    },
  });

  revalidatePath("/app", "layout");
  redirect(`/app/agents/${agent.id}`);
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

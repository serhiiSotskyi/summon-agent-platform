import { createHash, randomBytes } from "node:crypto";
import type { MembershipRole, Prisma, User } from "@prisma/client";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

const INVITE_TTL_DAYS = 14;

type InviteDeliveryStatus = {
  sent: boolean;
  provider: "resend" | "manual";
  reason?: string;
};

export type InvitationResult =
  | { status: "accepted"; workspaceId: string }
  | { status: "email-mismatch"; invitedEmail: string; signedInEmail: string }
  | { status: "expired" | "invalid" | "not-pending" };

export function normalizeInviteEmail(email: string) {
  return email.trim().toLowerCase();
}

function inviteToken() {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function getAppBaseUrl() {
  const configured =
    getEnv("APP_URL") ??
    getEnv("NEXT_PUBLIC_APP_URL") ??
    getEnv("VERCEL_PROJECT_PRODUCTION_URL") ??
    getEnv("VERCEL_URL");

  if (configured) {
    const withProtocol = configured.startsWith("http")
      ? configured
      : `https://${configured}`;
    return withProtocol.replace(/\/+$/, "");
  }

  return "http://localhost:3000";
}

export function buildInviteUrl(token: string) {
  return `${getAppBaseUrl()}/invite/${token}`;
}

function inviteExpiresAt() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITE_TTL_DAYS);
  return expiresAt;
}

async function sendInviteEmail({
  email,
  inviteUrl,
  inviterName,
  role,
  workspaceName,
}: {
  email: string;
  inviteUrl: string;
  inviterName: string | null;
  role: MembershipRole;
  workspaceName: string;
}): Promise<InviteDeliveryStatus> {
  const apiKey = getEnv("RESEND_API_KEY");
  const from = getEnv("INVITE_FROM_EMAIL");

  if (!apiKey || !from) {
    return {
      sent: false,
      provider: "manual",
      reason: "Email delivery is not configured.",
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: `Join ${workspaceName} on Summon Agent Platform`,
      html: [
        `<p>${inviterName ?? "A workspace admin"} invited you to join <strong>${workspaceName}</strong> as <strong>${role.toLowerCase()}</strong>.</p>`,
        `<p><a href="${inviteUrl}">Accept your invitation</a></p>`,
        `<p>This invite expires in ${INVITE_TTL_DAYS} days.</p>`,
      ].join(""),
      text: [
        `${inviterName ?? "A workspace admin"} invited you to join ${workspaceName} as ${role.toLowerCase()}.`,
        "",
        `Accept your invitation: ${inviteUrl}`,
        "",
        `This invite expires in ${INVITE_TTL_DAYS} days.`,
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: unknown; name?: unknown }
      | null;
    const providerMessage =
      typeof payload?.message === "string" ? payload.message : null;
    const providerName =
      typeof payload?.name === "string" ? payload.name : null;
    const reason = [providerMessage, providerName ? `(${providerName})` : null]
      .filter(Boolean)
      .join(" ");

    return {
      sent: false,
      provider: "resend",
      reason: reason
        ? `Resend returned ${response.status}: ${reason}`
        : `Resend returned ${response.status}.`,
    };
  }

  return { sent: true, provider: "resend" };
}

export async function createOrRefreshWorkspaceInvitation({
  email,
  invitedBy,
  role,
  workspaceId,
}: {
  email: string;
  invitedBy: User;
  role: MembershipRole;
  workspaceId: string;
}) {
  const db = getDb();
  const token = inviteToken();
  const inviteUrl = buildInviteUrl(token);
  const tokenHash = hashInviteToken(token);
  const expiresAt = inviteExpiresAt();
  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true },
  });

  const invitation = await db.workspaceInvitation.upsert({
    where: {
      workspaceId_email: {
        workspaceId,
        email,
      },
    },
    create: {
      workspaceId,
      email,
      role,
      invitedById: invitedBy.id,
      tokenHash,
      expiresAt,
      status: "PENDING",
    },
    update: {
      acceptedAt: null,
      acceptedById: null,
      expiresAt,
      invitedById: invitedBy.id,
      role,
      status: "PENDING",
      tokenHash,
    },
  });

  const deliveryStatus = await sendInviteEmail({
    email,
    inviteUrl,
    inviterName: invitedBy.name,
    role,
    workspaceName: workspace.name,
  });

  await db.workspaceInvitation.update({
    where: { id: invitation.id },
    data: {
      deliveryStatus: deliveryStatus as unknown as Prisma.InputJsonObject,
      lastSentAt: deliveryStatus.sent ? new Date() : null,
    },
  });

  return {
    deliveryStatus,
    inviteUrl,
    invitation,
  };
}

export async function getWorkspaceInvitationPreview(token: string) {
  const tokenHash = hashInviteToken(token);
  const invitation = await getDb().workspaceInvitation.findUnique({
    where: { tokenHash },
    include: {
      invitedBy: { select: { name: true, email: true } },
      workspace: { select: { id: true, name: true } },
    },
  });

  if (!invitation) {
    return null;
  }

  return {
    email: invitation.email,
    expiresAt: invitation.expiresAt,
    invitedBy:
      invitation.invitedBy?.name ?? invitation.invitedBy?.email ?? null,
    isExpired: invitation.expiresAt
      ? invitation.expiresAt.getTime() < Date.now()
      : false,
    role: invitation.role,
    status: invitation.status,
    workspaceId: invitation.workspace.id,
    workspaceName: invitation.workspace.name,
  };
}

export async function acceptWorkspaceInvitationForUser(
  token: string,
  user: User,
): Promise<InvitationResult> {
  const db = getDb();
  const invitation = await db.workspaceInvitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
  });

  if (!invitation) {
    return { status: "invalid" };
  }

  if (invitation.status !== "PENDING") {
    return { status: "not-pending" };
  }

  if (invitation.expiresAt && invitation.expiresAt.getTime() < Date.now()) {
    await db.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return { status: "expired" };
  }

  const signedInEmail = normalizeInviteEmail(user.email);
  if (normalizeInviteEmail(invitation.email) !== signedInEmail) {
    return {
      status: "email-mismatch",
      invitedEmail: invitation.email,
      signedInEmail,
    };
  }

  await db.$transaction([
    db.workspaceMembership.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.workspaceId,
          userId: user.id,
        },
      },
      create: {
        workspaceId: invitation.workspaceId,
        userId: user.id,
        role: invitation.role,
        invitedById: invitation.invitedById,
        status: "ACTIVE",
      },
      update: {
        invitedById: invitation.invitedById,
        role: invitation.role,
        status: "ACTIVE",
      },
    }),
    db.workspaceInvitation.update({
      where: { id: invitation.id },
      data: {
        acceptedAt: new Date(),
        acceptedById: user.id,
        status: "ACCEPTED",
      },
    }),
  ]);

  return { status: "accepted", workspaceId: invitation.workspaceId };
}

import { auth } from "@clerk/nextjs/server";
import type { MembershipRole, User, Workspace } from "@prisma/client";
import { getDb } from "@/lib/db";
import {
  canCreateAgent as canCreateAgentForRole,
  canManageWorkspace as canManageWorkspaceForRole,
} from "./permissions";
import { createWorkspaceWithOwnerMembership } from "./workspaces";

type Claims = Record<string, unknown>;

export type WorkspaceSummary = Workspace & {
  role: MembershipRole;
};

export type CurrentUserContext =
  | {
      isAuthenticated: false;
      clerkUserId: null;
      user: null;
      workspace: null;
      workspaces: [];
      role: null;
      needsOnboarding: false;
    }
  | {
      isAuthenticated: true;
      clerkUserId: string;
      user: User;
      workspace: WorkspaceSummary;
      workspaces: WorkspaceSummary[];
      role: MembershipRole;
      needsOnboarding: boolean;
    };

function getClaim(claims: Claims | undefined, keys: string[]) {
  for (const key of keys) {
    const value = claims?.[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function getUserEmail(clerkUserId: string, claims: Claims | undefined) {
  const email =
    getClaim(claims, ["email", "primary_email_address", "email_address"]) ??
    `${clerkUserId}@clerk.local`;

  return email.toLowerCase();
}

function getUserName(claims: Claims | undefined) {
  const fullName = getClaim(claims, ["name", "full_name"]);
  if (fullName) {
    return fullName;
  }

  const first = getClaim(claims, ["first_name", "given_name"]);
  const last = getClaim(claims, ["last_name", "family_name"]);
  return [first, last].filter(Boolean).join(" ") || undefined;
}

async function ensureDbUser(clerkUserId: string, claims: Claims | undefined) {
  const db = getDb();
  const email = getUserEmail(clerkUserId, claims);
  const name = getUserName(claims);

  return db.user.upsert({
    where: { clerkUserId },
    create: {
      clerkUserId,
      email,
      name,
    },
    update: {
      email,
      name,
    },
  });
}

async function ensureOwnerMembership(workspaceId: string, userId: string) {
  await getDb().workspaceMembership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
    create: {
      workspaceId,
      userId,
      role: "OWNER",
    },
    update: {
      status: "ACTIVE",
      role: "OWNER",
    },
  });
}

export async function ensurePersonalWorkspace(user: User) {
  const db = getDb();
  const existing = await db.workspace.findFirst({
    where: {
      ownerId: user.id,
      type: "PERSONAL",
    },
  });

  if (existing) {
    await ensureOwnerMembership(existing.id, user.id);
    return existing;
  }

  try {
    const workspace = await createWorkspaceWithOwnerMembership({
      name: "Personal workspace",
      recoverFromSlugConflict: () =>
        db.workspace.findFirst({
          where: {
            ownerId: user.id,
            type: "PERSONAL",
          },
        }),
      slugBase: user.email.split("@")[0] || "personal",
      type: "PERSONAL",
      ownerId: user.id,
    });
    await ensureOwnerMembership(workspace.id, user.id);
    return workspace;
  } catch (error) {
    const recovered = await db.workspace.findFirst({
      where: {
        ownerId: user.id,
        type: "PERSONAL",
      },
    });

    if (recovered) {
      await ensureOwnerMembership(recovered.id, user.id);
      return recovered;
    }

    throw error;
  }
}

export async function getAuthenticatedDbUser() {
  const authResult = await auth();
  const clerkUserId = authResult.userId;

  if (!clerkUserId) {
    return null;
  }

  const claims = authResult.sessionClaims as Claims | undefined;
  const user = await ensureDbUser(clerkUserId, claims);

  return {
    clerkUserId,
    user,
  };
}

export async function getCurrentUserContext(workspaceId?: string) {
  const authenticatedUser = await getAuthenticatedDbUser();

  if (!authenticatedUser) {
    return {
      isAuthenticated: false,
      clerkUserId: null,
      user: null,
      workspace: null,
      workspaces: [],
      role: null,
      needsOnboarding: false,
    } satisfies CurrentUserContext;
  }

  const { clerkUserId, user } = authenticatedUser;
  await ensurePersonalWorkspace(user);

  const memberships = await getDb().workspaceMembership.findMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
    },
    include: {
      workspace: true,
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });

  const workspaces = memberships
    .map((membership) => ({
      ...membership.workspace,
      role: membership.role,
    }))
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "SHARED" ? -1 : 1;
      }

      return a.createdAt.getTime() - b.createdAt.getTime();
    });

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ??
    workspaces[0];

  return {
    isAuthenticated: true,
    clerkUserId,
    user,
    workspace: selectedWorkspace,
    workspaces,
    role: selectedWorkspace.role,
    needsOnboarding: !workspaces.some((workspace) => workspace.type === "SHARED"),
  } satisfies CurrentUserContext;
}

export function canManageWorkspace(role: MembershipRole | null) {
  return canManageWorkspaceForRole(role);
}

export function canCreateAgent(role: MembershipRole | null) {
  return canCreateAgentForRole(role);
}

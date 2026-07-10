import type { MembershipRole, User } from "@prisma/client";
import { ensurePersonalWorkspace } from "@/lib/app/context";
import { getDb } from "@/lib/db";
import { extractBearerToken, verifyMcpAccessToken } from "@/lib/mcp/oauth";

export type McpWorkspaceContext = {
  role: MembershipRole;
  workspace: {
    id: string;
    name: string;
    slug: string;
    type: string;
  };
};

export type McpUserContext = {
  accessTokenId: string;
  role: MembershipRole;
  scope: string;
  user: User;
  workspace: McpWorkspaceContext["workspace"];
  workspaces: McpWorkspaceContext[];
};

function sortWorkspaces(a: McpWorkspaceContext, b: McpWorkspaceContext) {
  if (a.workspace.type !== b.workspace.type) {
    return a.workspace.type === "SHARED" ? -1 : 1;
  }

  return a.workspace.name.localeCompare(b.workspace.name);
}

export async function getMcpUserContext({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId?: string;
}) {
  const payload = verifyMcpAccessToken(token);
  if (!payload) {
    return null;
  }

  const db = getDb();
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    return null;
  }

  await ensurePersonalWorkspace(user);

  const memberships = await db.workspaceMembership.findMany({
    where: {
      status: "ACTIVE",
      userId: user.id,
    },
    include: {
      workspace: true,
    },
  });

  const workspaces = memberships
    .map((membership) => ({
      role: membership.role,
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        type: membership.workspace.type,
      },
    }))
    .sort(sortWorkspaces);

  const selectedWorkspace =
    workspaces.find((item) => item.workspace.id === workspaceId) ?? workspaces[0];

  if (!selectedWorkspace) {
    return null;
  }

  return {
    accessTokenId: payload.jti,
    role: selectedWorkspace.role,
    scope: payload.scope,
    user,
    workspace: selectedWorkspace.workspace,
    workspaces,
  } satisfies McpUserContext;
}

export async function getMcpUserContextFromRequest(
  request: Request,
  workspaceId?: string,
) {
  const token = extractBearerToken(request);
  if (!token) {
    return null;
  }

  return getMcpUserContext({ token, workspaceId });
}

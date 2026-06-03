import { Plus, Users } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/form";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { canManageWorkspace, getCurrentUserContext } from "@/lib/app/context";
import { formatRelativeTime } from "@/lib/app/format";
import { getDb } from "@/lib/db";
import { createSharedWorkspace, inviteWorkspaceMember } from "../actions";

type SearchParams = Promise<{ workspace?: string }>;

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const canInvite = canManageWorkspace(context.role);
  const isSharedWorkspace = context.workspace.type === "SHARED";
  const memberships = await getDb().workspaceMembership.findMany({
    where: {
      workspaceId: context.workspace.id,
      status: "ACTIVE",
    },
    include: {
      user: { select: { email: true, name: true } },
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });

  return (
    <>
      <PageHeader
        description="Manage personal and shared workspace contexts for agents, connectors, and approvals."
        eyebrow="Workspaces"
        title="Workspace management"
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Your workspaces</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Type</TH>
                    <TH>Role</TH>
                    <TH>Created</TH>
                  </TR>
                </THead>
                <TBody>
                  {context.workspaces.map((workspace) => (
                    <TR key={workspace.id}>
                      <TD className="font-medium text-white">
                        <Link
                          className="transition hover:text-emerald-200"
                          href={`/app/workspaces?workspace=${workspace.id}`}
                        >
                          {workspace.name}
                        </Link>
                      </TD>
                      <TD>
                        <StatusBadge status={workspace.type} />
                      </TD>
                      <TD>{workspace.role.toLowerCase()}</TD>
                      <TD>{formatRelativeTime(workspace.createdAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
              <CardDescription>
                Active members for {context.workspace.name}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>Member</TH>
                    <TH>Email</TH>
                    <TH>Role</TH>
                    <TH>Joined</TH>
                  </TR>
                </THead>
                <TBody>
                  {memberships.map((membership) => (
                    <TR key={membership.id}>
                      <TD className="font-medium text-white">
                        {membership.user.name ?? "Unnamed user"}
                      </TD>
                      <TD>{membership.user.email}</TD>
                      <TD>
                        <StatusBadge status={membership.role} />
                      </TD>
                      <TD>{formatRelativeTime(membership.createdAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {isSharedWorkspace ? "Invite member" : "Create shared workspace"}
            </CardTitle>
            <CardDescription>
              {isSharedWorkspace
                ? "Add a teammate who has already signed into this app once."
                : "Personal workspaces cannot be shared. Create a shared workspace for team agents."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isSharedWorkspace && canInvite ? (
              <form action={inviteWorkspaceMember} className="space-y-4">
                <input
                  name="workspaceId"
                  type="hidden"
                  value={context.workspace.id}
                />
                <div className="space-y-2">
                  <Label htmlFor="email">Member email</Label>
                  <Input
                    id="email"
                    name="email"
                    placeholder="teammate@example.com"
                    type="email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role">Role</Label>
                  <Select defaultValue="CREATOR" id="role" name="role">
                    <option value="ADMIN">Admin</option>
                    <option value="CREATOR">Creator</option>
                    <option value="VIEWER">Viewer</option>
                  </Select>
                </div>
                <Button type="submit">
                  <Users aria-hidden />
                  Add member
                </Button>
              </form>
            ) : null}

            {isSharedWorkspace && !canInvite ? (
              <div className="rounded-md border border-white/10 bg-black/20 p-4 text-sm leading-6 text-zinc-400">
                Only workspace owners and admins can invite members.
              </div>
            ) : null}

            {!isSharedWorkspace ? (
              <div className="rounded-md border border-white/10 bg-black/20 p-4 text-sm leading-6 text-zinc-400">
                <Users aria-hidden className="mb-3 size-4 text-zinc-300" />
                Select a shared workspace or create one below before inviting
                teammates.
              </div>
            ) : null}

            <div className="my-5 h-px bg-white/10" />

            <form action={createSharedWorkspace} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Workspace name</Label>
                <Input id="name" name="name" placeholder="Client or team name" />
              </div>
              <Button type="submit">
                <Plus aria-hidden />
                Create workspace
              </Button>
            </form>
            <div className="mt-5 rounded-md border border-white/10 bg-black/20 p-4 text-sm leading-6 text-zinc-400">
              <Users aria-hidden className="mb-3 size-4 text-zinc-300" />
              Email delivery is not enabled yet. For v1, ask the teammate to
              sign into the app once, then add them by email here.
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

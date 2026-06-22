import { Bot, Plus } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getCurrentUserContext } from "@/lib/app/context";
import { demoAgents } from "@/lib/app/demo";
import { formatRelativeTime } from "@/lib/app/format";
import { getDb } from "@/lib/db";

type SearchParams = Promise<{ workspace?: string; demo?: string }>;

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const demo = params.demo === "1";
  const agents = demo
    ? demoAgents
    : await getDb().agent.findMany({
        where: {
          workspaceId: context.workspace.id,
          status: { not: "DELETED" },
        },
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          triggerType: true,
          llmProvider: true,
          llmModel: true,
          updatedAt: true,
          createdBy: {
            select: { name: true, email: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      });
  const latestRuns = demo
    ? []
    : await getDb().agentRun.findMany({
        where: {
          agentId: { in: agents.map((agent) => agent.id) },
        },
        orderBy: { triggeredAt: "desc" },
        select: {
          agentId: true,
          triggeredAt: true,
        },
      });
  const latestRunByAgent = new Map<string, Date>();

  for (const run of latestRuns) {
    if (!latestRunByAgent.has(run.agentId)) {
      latestRunByAgent.set(run.agentId, run.triggeredAt);
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <Button asChild>
            <Link href={`/app/agents/new?workspace=${context.workspace.id}${demo ? "&demo=1" : ""}`}>
              <Plus aria-hidden />
              New agent
            </Link>
          </Button>
        }
        description="Create, filter, and inspect workspace agents."
        eyebrow={demo ? "Agents - demo" : "Agents"}
        title="Agent library"
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Workspace agents</CardTitle>
          {demo ? <Badge variant="demo">Demo data</Badge> : null}
        </CardHeader>
        <CardContent>
          {agents.length > 0 ? (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Status</TH>
                  <TH>Trigger</TH>
                  <TH>Model</TH>
                  <TH>Last run</TH>
                </TR>
              </THead>
              <TBody>
                {agents.map((agent) => {
                  const lastRunAt =
                    "lastRun" in agent
                      ? agent.lastRun
                      : latestRunByAgent.get(agent.id);

                  return (
                    <TR key={agent.id}>
                      <TD>
                        <Link
                          className="font-medium text-white hover:text-emerald-200"
                          href={`/app/agents/${agent.id}?workspace=${context.workspace.id}${demo ? "&demo=1" : ""}`}
                        >
                          {agent.name}
                        </Link>
                        <p className="mt-1 max-w-xl truncate text-xs text-zinc-500">
                          {agent.description}
                        </p>
                      </TD>
                      <TD>
                        <StatusBadge status={agent.status} />
                      </TD>
                      <TD>{agent.triggerType.toLowerCase()}</TD>
                      <TD>
                        {agent.llmProvider} / {agent.llmModel}
                      </TD>
                      <TD>{formatRelativeTime(lastRunAt)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          ) : (
            <EmptyState
              action={
                <Button asChild>
                  <Link href={`/app/agents/new?workspace=${context.workspace.id}`}>
                    Create first agent
                  </Link>
                </Button>
              }
              description="Agents start as drafts so the team can review the prompt, model choice, permissions, and schedule before activation."
              icon={Bot}
              title="No agents yet"
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

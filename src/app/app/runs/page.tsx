import { History } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { RunEvidenceCounts } from "@/components/app/run-evidence-counts";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getCurrentUserContext } from "@/lib/app/context";
import { formatRelativeTime, formatUsd } from "@/lib/app/format";
import { getDb } from "@/lib/db";

type SearchParams = Promise<{ workspace?: string }>;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const runs = await getDb().agentRun.findMany({
    where: { agent: { workspaceId: context.workspace.id } },
    select: {
      id: true,
      agentId: true,
      triggeredById: true,
      triggerType: true,
      status: true,
      triggeredAt: true,
      costEstimate: true,
    },
    orderBy: { triggeredAt: "desc" },
    take: 50,
  });
  const runIds = runs.map((run) => run.id);
  const agentIds = Array.from(new Set(runs.map((run) => run.agentId)));
  const triggeredByIds = Array.from(
    new Set(runs.map((run) => run.triggeredById).filter(Boolean)),
  ) as string[];
  const [agents, triggeredByUsers, artifactCounts, toolCallCounts] =
    runIds.length > 0
      ? await Promise.all([
          getDb().agent.findMany({
            where: { id: { in: agentIds }, workspaceId: context.workspace.id },
            select: { id: true, name: true },
          }),
          triggeredByIds.length > 0
            ? getDb().user.findMany({
                where: { id: { in: triggeredByIds } },
                select: { id: true, name: true, email: true },
              })
            : Promise.resolve([]),
          getDb().agentArtifact.groupBy({
            by: ["agentRunId"],
            where: { agentRunId: { in: runIds } },
            _count: { _all: true },
          }),
          getDb().toolCall.groupBy({
            by: ["agentRunId"],
            where: { agentRunId: { in: runIds } },
            _count: { _all: true },
          }),
        ])
      : [[], [], [], []];
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const triggeredByById = new Map(
    triggeredByUsers.map((user) => [user.id, user.name ?? user.email]),
  );
  const artifactCountByRunId = new Map(
    artifactCounts.map((count) => [count.agentRunId, count._count._all]),
  );
  const toolCallCountByRunId = new Map(
    toolCallCounts.map((count) => [count.agentRunId, count._count._all]),
  );

  return (
    <>
      <PageHeader
        description="Chronological execution history across workspace agents."
        eyebrow="Runs"
        title="Run history"
      />
      <Card>
        <CardHeader>
          <CardTitle>Workspace runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length > 0 ? (
            <Table>
              <THead>
                <TR>
                  <TH>Agent</TH>
                  <TH>Status</TH>
                  <TH>Trigger</TH>
                  <TH>Started</TH>
                  <TH>Evidence</TH>
                  <TH>Cost</TH>
                  <TH>By</TH>
                </TR>
              </THead>
              <TBody>
                {runs.map((run) => (
                  <TR key={run.id}>
                    <TD>
                      <Link
                        className="font-medium text-white hover:text-emerald-200"
                        href={`/app/runs/${run.id}?workspace=${context.workspace.id}`}
                      >
                        {agentNameById.get(run.agentId) ?? "Unknown agent"}
                      </Link>
                    </TD>
                    <TD>
                      <StatusBadge status={run.status} />
                    </TD>
                    <TD>{run.triggerType.toLowerCase()}</TD>
                    <TD>{formatRelativeTime(run.triggeredAt)}</TD>
                    <TD>
                      <RunEvidenceCounts
                        artifacts={artifactCountByRunId.get(run.id) ?? 0}
                        toolCalls={toolCallCountByRunId.get(run.id) ?? 0}
                      />
                    </TD>
                    <TD>
                      {run.costEstimate ? formatUsd(run.costEstimate.toNumber()) : "Unknown"}
                    </TD>
                    <TD>
                      {run.triggeredById
                        ? (triggeredByById.get(run.triggeredById) ?? "Unknown user")
                        : "System"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <EmptyState
              description="Runs are created when a team member clicks Run now or when a scheduled agent fires."
              icon={History}
              title="No runs yet"
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

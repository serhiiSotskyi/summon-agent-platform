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
    include: {
      agent: { select: { name: true } },
      triggeredBy: { select: { name: true, email: true } },
      _count: { select: { artifacts: true, toolCalls: true } },
    },
    orderBy: { triggeredAt: "desc" },
    take: 50,
  });

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
                        {run.agent.name}
                      </Link>
                    </TD>
                    <TD>
                      <StatusBadge status={run.status} />
                    </TD>
                    <TD>{run.triggerType.toLowerCase()}</TD>
                    <TD>{formatRelativeTime(run.triggeredAt)}</TD>
                    <TD>
                      <RunEvidenceCounts
                        artifacts={run._count.artifacts}
                        toolCalls={run._count.toolCalls}
                      />
                    </TD>
                    <TD>
                      {run.costEstimate ? formatUsd(run.costEstimate.toNumber()) : "Unknown"}
                    </TD>
                    <TD>{run.triggeredBy?.name ?? run.triggeredBy?.email ?? "System"}</TD>
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

import { Activity, Bot, Cable, ClipboardCheck, DollarSign, History } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { MetricCard } from "@/components/app/metric-card";
import { PageHeader } from "@/components/app/page-header";
import { RunEvidenceCounts } from "@/components/app/run-evidence-counts";
import { SetupChecklist } from "@/components/app/setup-checklist";
import { StatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getCurrentUserContext } from "@/lib/app/context";
import { demoDashboard } from "@/lib/app/demo";
import { getWorkspaceDashboard } from "@/lib/app/dashboard";
import { formatRelativeTime, formatUsd } from "@/lib/app/format";

type SearchParams = Promise<{
  workspace?: string;
  demo?: string;
}>;

export default async function AppDashboard({
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
  const dashboard = demo
    ? {
        ...demoDashboard,
        setupChecklist: [
          { label: "Create a shared workspace", complete: true, href: "/app/onboarding" },
          { label: "Connect at least one tool", complete: true, href: "/app/connectors" },
          { label: "Create your first agent", complete: true, href: "/app/agents/new" },
          { label: "Run an agent", complete: true, href: "/app/agents" },
        ],
        connectorStatuses: [],
      }
    : await getWorkspaceDashboard(context.workspace.id);

  return (
    <>
      <PageHeader
        actions={
          <Button asChild>
            <Link href={`/app/agents/new?workspace=${context.workspace.id}${demo ? "&demo=1" : ""}`}>
              <Bot aria-hidden />
              New agent
            </Link>
          </Button>
        }
        description="A real workspace view over agents, runs, connectors, and approvals."
        eyebrow={demo ? "Dashboard - demo" : "Dashboard"}
        title="Workspace control plane"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <MetricCard icon={Bot} label="Agents" value={dashboard.counts.agents} />
        <MetricCard
          icon={Activity}
          label="Active"
          value={dashboard.counts.activeAgents}
        />
        <MetricCard icon={History} label="Runs" value={dashboard.counts.runs} />
        <MetricCard
          icon={ClipboardCheck}
          label="Approvals"
          value={dashboard.counts.pendingApprovals}
        />
        <MetricCard
          icon={Cable}
          label="Connectors"
          value={dashboard.counts.connectors}
        />
        <MetricCard
          icon={DollarSign}
          label="30d AI cost"
          value={formatUsd(dashboard.counts.estimatedSpend30d)}
        />
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle>Recent runs</CardTitle>
            {demo ? <Badge variant="demo">Demo data</Badge> : null}
          </CardHeader>
          <CardContent>
            {dashboard.recentRuns.length > 0 ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Agent</TH>
                    <TH>Status</TH>
                    <TH>Trigger</TH>
                    <TH>Evidence</TH>
                    <TH>Started</TH>
                  </TR>
                </THead>
                <TBody>
                  {dashboard.recentRuns.map((run) => (
                    <TR key={run.id}>
                      <TD className="font-medium text-white">{run.agentName}</TD>
                      <TD>
                        <StatusBadge status={run.status} />
                      </TD>
                      <TD>{run.triggerType.toLowerCase()}</TD>
                      <TD>
                        <RunEvidenceCounts
                          artifacts={run.artifacts}
                          toolCalls={run.toolCalls}
                        />
                      </TD>
                      <TD>{formatRelativeTime(run.triggeredAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState
                action={
                  <Button asChild>
                    <Link href={`/app/agents?workspace=${context.workspace.id}`}>
                      View agents
                    </Link>
                  </Button>
                }
                description="Create an agent and run it manually to start building workspace history."
                icon={History}
                title="No runs yet"
              />
            )}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <SetupChecklist
            demo={demo}
            items={dashboard.setupChecklist}
            workspaceId={context.workspace.id}
          />

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle>Approval queue</CardTitle>
              {demo ? <Badge variant="demo">Demo</Badge> : null}
            </CardHeader>
            <CardContent className="space-y-3">
              {dashboard.approvals.length > 0 ? (
                dashboard.approvals.map((approval) => (
                  <Link
                    className="block rounded-md border border-white/10 bg-black/20 p-3 transition hover:bg-white/[0.06]"
                    href={`/app/approvals?workspace=${context.workspace.id}${demo ? "&demo=1" : ""}`}
                    key={approval.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium leading-5 text-white">
                        {approval.action}
                      </p>
                      <StatusBadge status={approval.riskLevel} />
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      {approval.agentName} - {formatRelativeTime(approval.createdAt)}
                    </p>
                  </Link>
                ))
              ) : (
                <p className="rounded-md border border-white/10 bg-black/20 p-4 text-sm leading-6 text-zinc-400">
                  No approvals waiting. Protected actions will appear here when
                  agents propose them.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

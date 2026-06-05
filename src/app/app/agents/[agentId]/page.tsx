import { ArrowLeft, Edit, Pause, Play, Rocket } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { canCreateAgent } from "@/lib/app/permissions";
import {
  formatScheduleSummary,
  getNextScheduleDate,
  readScheduleConfig,
} from "@/lib/agents/schedules";
import { getDb } from "@/lib/db";
import { activateAgent, createManualRun, pauseAgent } from "../../actions";

type Params = Promise<{ agentId: string }>;
type SearchParams = Promise<{ workspace?: string; demo?: string }>;

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);
  const context = await getCurrentUserContext(query.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const demo = query.demo === "1";
  const agent = demo
    ? demoAgents.find((item) => item.id === agentId)
    : await getDb().agent.findFirst({
        where: {
          id: agentId,
          workspaceId: context.workspace.id,
          status: { not: "DELETED" },
        },
        include: {
          runs: {
            orderBy: { triggeredAt: "desc" },
            take: 10,
          },
          createdBy: {
            select: { name: true, email: true },
          },
        },
      });

  if (!agent) {
    notFound();
  }

  const schedule =
    !demo && "triggerConfig" in agent ? readScheduleConfig(agent.triggerConfig) : null;
  const nextScheduledRun = getNextScheduleDate(schedule);
  const canEdit = !demo && canCreateAgent(context.role);

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href={`/app/agents?workspace=${context.workspace.id}${demo ? "&demo=1" : ""}`}>
                <ArrowLeft aria-hidden />
                Agents
              </Link>
            </Button>
            {canEdit ? (
              <Button asChild variant="secondary">
                <Link href={`/app/agents/${agent.id}/edit?workspace=${context.workspace.id}`}>
                  <Edit aria-hidden />
                  Edit
                </Link>
              </Button>
            ) : null}
            {canEdit && agent.status !== "ACTIVE" ? (
              <form action={activateAgent}>
                <input name="agentId" type="hidden" value={agent.id} />
                <input
                  name="workspaceId"
                  type="hidden"
                  value={context.workspace.id}
                />
                <Button type="submit">
                  <Rocket aria-hidden />
                  Activate
                </Button>
              </form>
            ) : null}
            {canEdit && agent.status === "ACTIVE" ? (
              <form action={pauseAgent}>
                <input name="agentId" type="hidden" value={agent.id} />
                <input
                  name="workspaceId"
                  type="hidden"
                  value={context.workspace.id}
                />
                <Button type="submit" variant="secondary">
                  <Pause aria-hidden />
                  Pause
                </Button>
              </form>
            ) : null}
            {!demo ? (
              <form action={createManualRun}>
                <input name="agentId" type="hidden" value={agent.id} />
                <input
                  name="workspaceId"
                  type="hidden"
                  value={context.workspace.id}
                />
                <Button type="submit">
                  <Play aria-hidden />
                  Run test
                </Button>
              </form>
            ) : null}
          </>
        }
        description={agent.description ?? "Draft workspace agent."}
        eyebrow={demo ? "Agent - demo" : "Agent"}
        title={agent.name}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(360px,0.55fr)]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle>Configuration</CardTitle>
            {demo ? <Badge variant="demo">Demo</Badge> : null}
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Status
              </p>
              <div className="mt-2">
                <StatusBadge status={agent.status} />
              </div>
            </div>
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Model
              </p>
              <p className="mt-2 text-sm text-white">
                {agent.llmProvider} / {agent.llmModel}
              </p>
            </div>
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Trigger
              </p>
              <p className="mt-2 text-sm text-white">
                {agent.triggerType.toLowerCase()}
              </p>
              {agent.triggerType === "SCHEDULED" ? (
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                  {formatScheduleSummary(schedule)}
                </p>
              ) : null}
            </div>
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Action mode
              </p>
              <p className="mt-2 text-sm text-white">
                {"actionPermissionMode" in agent
                  ? agent.actionPermissionMode.replaceAll("_", " ").toLowerCase()
                  : "ask before changes"}
              </p>
            </div>
            {agent.triggerType === "SCHEDULED" ? (
              <div className="rounded-md border border-white/10 bg-black/20 p-4 md:col-span-2">
                <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                  Next scheduled run
                </p>
                <p className="mt-2 text-sm text-white">
                  {agent.status === "ACTIVE" && nextScheduledRun
                    ? `${nextScheduledRun.toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })} (${formatRelativeTime(nextScheduledRun)})`
                    : "Activate the agent to schedule runs."}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Run history</CardTitle>
          </CardHeader>
          <CardContent>
            {"runs" in agent && agent.runs.length > 0 ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Status</TH>
                    <TH>Started</TH>
                  </TR>
                </THead>
                <TBody>
                  {agent.runs.map((run) => (
                    <TR key={run.id}>
                      <TD>
                        <Link
                          className="hover:text-emerald-200"
                          href={`/app/runs/${run.id}?workspace=${context.workspace.id}`}
                        >
                          <StatusBadge status={run.status} />
                        </Link>
                      </TD>
                      <TD>{formatRelativeTime(run.triggeredAt)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState
                description="Manual and scheduled runs will appear here once this agent has been executed."
                icon={Play}
                title="No runs yet"
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

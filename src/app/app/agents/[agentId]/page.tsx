import {
  ArrowLeft,
  Edit,
  FileText,
  FileUp,
  Link2,
  Pause,
  Play,
  Rocket,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/form";
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
import {
  activateAgent,
  addAgentFile,
  createManualRun,
  pauseAgent,
  removeAgentFile,
} from "../../actions";

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
          files: {
            orderBy: { createdAt: "desc" },
          },
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

        {!demo ? (
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Agent files</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {"files" in agent && agent.files.length > 0 ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {agent.files.map((file) => (
                    <div
                      className="rounded-md border border-white/10 bg-black/20 p-4"
                      key={file.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <FileText
                              aria-hidden
                              className="size-4 text-emerald-200"
                            />
                            <p className="break-words text-sm font-medium text-white">
                              {file.name}
                            </p>
                            <Badge>{file.role.replaceAll("_", " ")}</Badge>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-zinc-500">
                            {file.sourceType.replaceAll("_", " ")}
                            {file.mimeType ? ` · ${file.mimeType}` : ""}
                            {file.sizeBytes
                              ? ` · ${(file.sizeBytes / 1024).toFixed(1)} KB`
                              : ""}
                          </p>
                          {file.description ? (
                            <p className="mt-2 text-sm leading-6 text-zinc-400">
                              {file.description}
                            </p>
                          ) : null}
                          {file.url ? (
                            <a
                              className="mt-3 inline-flex items-center gap-2 text-sm text-emerald-200 hover:text-emerald-100"
                              href={file.url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              <Link2 aria-hidden className="size-4" />
                              Open reference
                            </a>
                          ) : null}
                        </div>
                        {canEdit ? (
                          <form action={removeAgentFile}>
                            <input name="agentId" type="hidden" value={agent.id} />
                            <input name="fileId" type="hidden" value={file.id} />
                            <input
                              name="workspaceId"
                              type="hidden"
                              value={context.workspace.id}
                            />
                            <Button
                              aria-label={`Remove ${file.name}`}
                              size="icon"
                              type="submit"
                              variant="ghost"
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  description="Attach source CSVs, helper Python, template decks, Drive files, Sheets, or Notion pages so this agent has explicit inputs."
                  icon={FileText}
                  title="No files attached"
                />
              )}

              {canEdit ? (
                <form
                  action={addAgentFile}
                  className="space-y-4 rounded-md border border-white/10 bg-black/20 p-4"
                  encType="multipart/form-data"
                >
                  <input name="agentId" type="hidden" value={agent.id} />
                  <input
                    name="workspaceId"
                    type="hidden"
                    value={context.workspace.id}
                  />
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium text-white">
                      <FileUp aria-hidden className="size-4 text-emerald-200" />
                      Add input
                    </p>
                    <p className="mt-1 text-sm leading-6 text-zinc-500">
                      Upload small text files or add a URL to Google Slides,
                      Sheets, Drive, Notion, or Looker Studio.
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-[1fr_170px]">
                    <div className="space-y-2">
                      <Label htmlFor="detailReferenceUrl">Reference URL</Label>
                      <Input
                        id="detailReferenceUrl"
                        name="referenceUrl"
                        placeholder="https://docs.google.com/..."
                        type="url"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="detailReferenceRole">Role</Label>
                      <Select
                        id="detailReferenceRole"
                        name="referenceRole"
                        defaultValue="reference"
                      >
                        <option value="template">Template</option>
                        <option value="input_data">Input data</option>
                        <option value="helper_code">Helper code</option>
                        <option value="reference">Reference</option>
                        <option value="output_destination">Output destination</option>
                        <option value="other">Other</option>
                      </Select>
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="detailReferenceName">Reference name</Label>
                      <Input
                        id="detailReferenceName"
                        name="referenceName"
                        placeholder="Optional"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="detailReferenceDescription">Notes</Label>
                      <Input
                        id="detailReferenceDescription"
                        name="referenceDescription"
                        placeholder="Optional instruction"
                      />
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-[1fr_170px]">
                    <div className="space-y-2">
                      <Label htmlFor="detailAgentFiles">Upload files</Label>
                      <Input
                        id="detailAgentFiles"
                        multiple
                        name="agentFiles"
                        type="file"
                        accept=".csv,.py,.txt,.md,.json,.yaml,.yml,text/*,application/json"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="detailUploadedFileRole">Upload role</Label>
                      <Select
                        id="detailUploadedFileRole"
                        name="uploadedFileRole"
                        defaultValue="input_data"
                      >
                        <option value="input_data">Input data</option>
                        <option value="helper_code">Helper code</option>
                        <option value="template">Template</option>
                        <option value="reference">Reference</option>
                        <option value="other">Other</option>
                      </Select>
                    </div>
                  </div>
                  <Button type="submit" variant="secondary">
                    <FileUp aria-hidden />
                    Add to agent
                  </Button>
                </form>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

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

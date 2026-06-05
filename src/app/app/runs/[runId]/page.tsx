import { ArrowLeft, Check, Clock, LoaderCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { PageHeader } from "@/components/app/page-header";
import { RunAutoRefresh } from "@/components/app/run-auto-refresh";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUserContext } from "@/lib/app/context";
import { formatRelativeTime, formatUsd } from "@/lib/app/format";
import { getDb } from "@/lib/db";

type Params = Promise<{ runId: string }>;
type SearchParams = Promise<{ workspace?: string }>;

export const dynamic = "force-dynamic";
export const revalidate = 0;

function timeline(status: string) {
  const steps = ["Queued", "Planning", "Tool calls", "Output", "Approval check"];
  const completed =
    status === "SUCCESS" ? 5 : status === "RUNNING" ? 2 : status === "FAILED" ? 1 : 0;

  return steps.map((step, index) => ({
    step,
    complete: index < completed,
    active: index === completed && status !== "SUCCESS" && status !== "FAILED",
  }));
}

function readOutputText(output: Prisma.JsonValue) {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "text" in output &&
    typeof output.text === "string"
  ) {
    return output.text;
  }

  return null;
}

function readMissingTools(output: Prisma.JsonValue) {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "missingTools" in output &&
    Array.isArray(output.missingTools)
  ) {
    return output.missingTools.filter(
      (tool): tool is string => typeof tool === "string",
    );
  }

  return [];
}

function readOutputMode(output: Prisma.JsonValue) {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "mode" in output &&
    typeof output.mode === "string"
  ) {
    return output.mode;
  }

  return null;
}

function readConnectorResults(output: Prisma.JsonValue) {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "connectorResults" in output &&
    Array.isArray(output.connectorResults)
  ) {
    return (output.connectorResults as unknown[]).filter(
      (result) =>
        Boolean(result) && typeof result === "object" && !Array.isArray(result),
    ) as Array<Record<string, unknown>>;
  }

  return [];
}

function readApprovalDecision(output: Prisma.JsonValue) {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "approvalDecision" in output &&
    output.approvalDecision &&
    typeof output.approvalDecision === "object" &&
    !Array.isArray(output.approvalDecision)
  ) {
    return output.approvalDecision as {
      status?: string;
      message?: string;
      reviewedAt?: string;
    };
  }

  return null;
}

function readCostMetadata(output: Prisma.JsonValue) {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "cost" in output &&
    output.cost &&
    typeof output.cost === "object" &&
    !Array.isArray(output.cost)
  ) {
    return output.cost as {
      status?: string;
      estimatedCostUsd?: number | null;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      } | null;
      pricingVersion?: string;
    };
  }

  return null;
}

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ runId }, query] = await Promise.all([params, searchParams]);
  const context = await getCurrentUserContext(query.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const run = await getDb().agentRun.findFirst({
    where: {
      id: runId,
      agent: { workspaceId: context.workspace.id },
    },
    include: {
      agent: true,
      triggeredBy: { select: { name: true, email: true } },
      approvalRequests: true,
    },
  });

  if (!run) {
    notFound();
  }

  const outputText = readOutputText(run.output);
  const outputMode = readOutputMode(run.output);
  const connectorResults = readConnectorResults(run.output);
  const missingTools = readMissingTools(run.output);
  const approvalDecision = readApprovalDecision(run.output);
  const costMetadata = readCostMetadata(run.output);
  const isActiveRun = run.status === "QUEUED" || run.status === "RUNNING";

  return (
    <>
      <RunAutoRefresh status={run.status} />

      <PageHeader
        actions={
          <Button asChild variant="secondary">
            <Link href={`/app/runs?workspace=${context.workspace.id}`}>
              <ArrowLeft aria-hidden />
              Runs
            </Link>
          </Button>
        }
        description={`${run.agent.name} - triggered ${formatRelativeTime(run.triggeredAt)}`}
        eyebrow="Run detail"
        title="Execution trace"
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.55fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {timeline(run.status).map((item) => (
              <div
                className="flex items-center gap-3 rounded-md border border-white/10 bg-black/20 p-3"
                key={item.step}
              >
                <span className="grid size-8 place-items-center rounded-md bg-white/5">
                  {item.complete ? (
                    <Check aria-hidden className="size-4 text-emerald-200" />
                  ) : item.active ? (
                    <LoaderCircle aria-hidden className="size-4 animate-spin text-cyan-200" />
                  ) : run.status === "FAILED" && item.step === "Planning" ? (
                    <XCircle aria-hidden className="size-4 text-red-200" />
                  ) : (
                    <Clock aria-hidden className="size-4 text-zinc-500" />
                  )}
                </span>
                <span className="text-sm text-zinc-200">{item.step}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Run summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Status
              </p>
              <div className="mt-2">
                <StatusBadge status={run.status} />
              </div>
            </div>
            <div className="rounded-md border border-white/10 bg-black/20 p-4 text-sm leading-6 text-zinc-300">
              {run.summary ?? "No output yet. Worker execution is queued."}
            </div>
            {isActiveRun ? (
              <div className="rounded-md border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
                Live refresh is active. If this stays here for several minutes,
                check that the worker is still running.
              </div>
            ) : null}
            {run.error ? (
              <div className="rounded-md border border-red-300/20 bg-red-300/10 p-4 text-sm leading-6 text-red-100">
                {run.error}
              </div>
            ) : null}
            {run.durationMs ? (
              <div className="rounded-md border border-white/10 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                  Duration
                </p>
                <p className="mt-2 text-sm text-white">{run.durationMs}ms</p>
              </div>
            ) : null}
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Estimated cost
              </p>
              <p className="mt-2 text-sm text-white">
                {run.costEstimate ? formatUsd(run.costEstimate.toNumber()) : "Unknown"}
              </p>
              {costMetadata?.status ? (
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                  {costMetadata.status.replaceAll("_", " ")}
                  {costMetadata.pricingVersion
                    ? ` - pricing ${costMetadata.pricingVersion}`
                    : ""}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      {costMetadata?.usage ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Token usage</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Input
              </p>
              <p className="mt-2 text-sm text-white">
                {costMetadata.usage.inputTokens?.toLocaleString() ?? "Unknown"}
              </p>
            </div>
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Output
              </p>
              <p className="mt-2 text-sm text-white">
                {costMetadata.usage.outputTokens?.toLocaleString() ?? "Unknown"}
              </p>
            </div>
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                Total
              </p>
              <p className="mt-2 text-sm text-white">
                {costMetadata.usage.totalTokens?.toLocaleString() ?? "Unknown"}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {connectorResults.length > 0 ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Connector evidence</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 xl:grid-cols-2">
            {connectorResults.map((result) => (
              <div
                className="rounded-md border border-white/10 bg-black/20 p-4"
                key={String(result.connectorType)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-white">
                      {String(result.connectorName ?? result.connectorType)}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                      {String(result.summary ?? "")}
                    </p>
                  </div>
                  <StatusBadge status={String(result.status ?? "unknown")} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {outputText ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>
              {outputMode === "read_only" ? "Read-only output" : "Run output"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="whitespace-pre-wrap rounded-md border border-white/10 bg-black/20 p-4 text-sm leading-6 text-zinc-200">
              {outputText}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {missingTools.length > 0 || run.approvalRequests.length > 0 ? (
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {missingTools.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Connector blockers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {missingTools.map((tool) => (
                  <div
                    className="rounded-md border border-amber-200/20 bg-amber-200/10 p-3 text-sm text-amber-100"
                    key={tool}
                  >
                    {tool} is not connected for this workspace.
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {run.approvalRequests.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Approvals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {approvalDecision ? (
                  <div className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-white">
                        Recorded decision
                      </span>
                      <StatusBadge status={approvalDecision.status ?? "reviewed"} />
                    </div>
                    {approvalDecision.message ? (
                      <p className="mt-2 text-sm leading-6 text-zinc-400">
                        {approvalDecision.message}
                      </p>
                    ) : null}
                    {approvalDecision.reviewedAt ? (
                      <p className="mt-2 text-xs text-zinc-500">
                        Reviewed {formatRelativeTime(new Date(approvalDecision.reviewedAt))}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {run.approvalRequests.map((approval) => (
                  <Link
                    className="flex items-center justify-between gap-4 rounded-md border border-white/10 bg-black/20 p-3 transition hover:bg-white/[0.06]"
                    href={`/app/approvals?workspace=${context.workspace.id}`}
                    key={approval.id}
                  >
                    <span className="text-sm text-white">
                      Review protected action
                    </span>
                    <StatusBadge status={approval.status} />
                  </Link>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

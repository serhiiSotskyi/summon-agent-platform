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

type OutputRecord = Record<string, unknown>;

function toRecord(value: unknown): value is OutputRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOutputArray(output: Prisma.JsonValue, keys: string[]) {
  if (!toRecord(output)) {
    return [];
  }

  const results: unknown[] = [];

  keys.forEach((key) => {
    const candidate = output[key];
    if (Array.isArray(candidate)) {
      results.push(...candidate);
    }
  });

  return results;
}

function readOutputObjectArray(output: Prisma.JsonValue, keys: string[]) {
  return readOutputArray(output, keys).filter(
    (item): item is OutputRecord | string =>
      (item !== null && typeof item === "object" && !Array.isArray(item)) ||
      typeof item === "string",
  ) as Array<OutputRecord | string>;
}

function firstText(record: OutputRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function readToolCalls(output: Prisma.JsonValue) {
  const entries = readOutputObjectArray(output, [
    "toolCalls",
    "tool_calls",
    "toolCallLog",
    "tool_call_log",
    "toolExecutions",
    "tool_execution_log",
  ]);

  return entries.map((entry, index) => {
    if (typeof entry === "string") {
      return {
        id: `tool-call-${index}`,
        name: entry,
        summary: null,
        status: "completed",
      };
    }

    const functionName =
      toRecord(entry.function) && firstText(entry.function as OutputRecord, ["name"]);

    const toolName =
      firstText(entry, [
        "toolName",
        "tool",
        "name",
        "type",
        "action",
      ]) ?? "Unnamed tool";

    return {
      id:
        firstText(entry, ["id", "callId", "toolCallId"]) ||
        `tool-call-${index}`,
      name: functionName ? `${toolName} (${functionName})` : toolName,
      connector: firstText(entry, ["connector", "provider", "source", "service"]),
      status: firstText(entry, ["status", "state", "result"]) || "completed",
      summary: firstText(entry, ["summary", "description", "details", "output"]),
      args: entry.args ?? entry.input ?? entry.parameters,
      result: entry.result,
    };
  });
}

function isArtifactKey(key: string) {
  return /artifact|attachment|file|document/.test(key);
}

function collectArtifactValues(output: Prisma.JsonValue) {
  if (!toRecord(output)) {
    return [];
  }

  const direct = readOutputObjectArray(output, [
    "artifacts",
    "generatedArtifacts",
    "artifactList",
    "attachments",
    "files",
  ]);

  const inferred: unknown[] = Object.entries(output).flatMap(([key, value]) => {
    if (isArtifactKey(key) && Array.isArray(value)) {
      return value;
    }

    return [];
  });

  return [...direct, ...inferred].filter(
    (item): item is OutputRecord | string =>
      (item !== null && typeof item === "object" && !Array.isArray(item)) ||
      typeof item === "string",
  ) as Array<OutputRecord | string>;
}

function readArtifacts(output: Prisma.JsonValue) {
  const entries = collectArtifactValues(output);

  return entries.map((entry, index) => {
    if (typeof entry === "string") {
      return {
        id: `artifact-${index}`,
        label: entry,
        title: entry,
        type: null,
        status: "ready",
        summary: null,
        url: null,
        raw: JSON.stringify(entry),
      };
    }

    return {
      id:
        firstText(entry, ["id", "artifactId", "fileId", "name"]) ||
        `artifact-${index}`,
      label: firstText(entry, ["name", "title", "label", "filename", "fileName"]) ||
        `Artifact ${index + 1}`,
      title: firstText(entry, ["title", "name", "label"]) || `Artifact ${index + 1}`,
      type: firstText(entry, ["type", "mimeType", "contentType"]),
      status: firstText(entry, ["status", "state"]) || "ready",
      summary: firstText(entry, ["summary", "description", "notes", "text"]),
      url:
        firstText(entry, [
          "url",
          "link",
          "viewUrl",
          "webViewLink",
          "downloadUrl",
          "fileUrl",
          "location",
        ]) || null,
      raw: JSON.stringify(entry),
    };
  });
}

function jsonPreview(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
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

function readEvidenceRecords(result: Record<string, unknown>) {
  if (!Array.isArray(result.records)) {
    return [];
  }

  return result.records.filter(
    (record) =>
      Boolean(record) && typeof record === "object" && !Array.isArray(record),
  ) as Array<Record<string, unknown>>;
}

function textField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : null;
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
  const toolCalls = readToolCalls(run.output);
  const artifacts = readArtifacts(run.output);
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
                className="space-y-4 rounded-md border border-white/10 bg-black/20 p-4"
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
                {readEvidenceRecords(result).length > 0 ? (
                  <div className="space-y-3">
                    {readEvidenceRecords(result)
                      .slice(0, 5)
                      .map((record, index) => {
                        const title =
                          textField(record, "title") ??
                          textField(record, "name") ??
                          "Untitled source";
                        const url =
                          textField(record, "url") ??
                          textField(record, "webViewLink");
                        const snippet =
                          textField(record, "snippet") ??
                          textField(record, "textPreview");
                        const query = textField(record, "query");
                        const source = textField(record, "source");
                        const type =
                          textField(record, "type") ??
                          textField(record, "mimeType") ??
                          textField(record, "object");
                        const lastUpdated =
                          textField(record, "lastUpdated") ??
                          textField(record, "lastEditedTime") ??
                          textField(record, "modifiedTime");
                        const exportError = textField(record, "exportError");

                        return (
                          <div
                            className="rounded-md border border-white/10 bg-black/20 p-3"
                            key={
                              textField(record, "evidenceId") ??
                              textField(record, "id") ??
                              `${String(result.connectorType)}-${index}`
                            }
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              {url ? (
                                <Link
                                  className="text-sm font-medium text-emerald-100 underline-offset-4 hover:underline"
                                  href={url}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  {title}
                                </Link>
                              ) : (
                                <p className="text-sm font-medium text-white">
                                  {title}
                                </p>
                              )}
                              {source ? (
                                <span className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                                  {source}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-2 text-xs leading-5 text-zinc-500">
                              {[type, query ? `query: ${query}` : null, lastUpdated]
                                .filter(Boolean)
                                .join(" - ")}
                            </p>
                            {snippet ? (
                              <p className="mt-3 line-clamp-4 text-sm leading-6 text-zinc-300">
                                {snippet}
                              </p>
                            ) : null}
                            {exportError ? (
                              <p className="mt-3 text-xs leading-5 text-amber-100">
                                {exportError}
                              </p>
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                ) : null}
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

      {(toolCalls.length > 0 || artifacts.length > 0) ? (
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {toolCalls.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Tool calls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {toolCalls.map((toolCall) => (
                  <div
                    className="space-y-3 rounded-md border border-white/10 bg-black/20 p-4"
                    key={toolCall.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-white">{toolCall.name}</p>
                      <StatusBadge status={toolCall.status ?? "completed"} />
                    </div>
                    <div className="space-y-2 text-sm leading-6 text-zinc-300">
                      {toolCall.connector ? (
                        <p>
                          Connector: <span className="text-zinc-200">{toolCall.connector}</span>
                        </p>
                      ) : null}
                      {toolCall.summary ? <p>{toolCall.summary}</p> : null}
                      {toolCall.args ? (
                        <div>
                          <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                            Arguments
                          </p>
                          <pre className="mt-2 whitespace-pre-wrap rounded-md border border-white/10 bg-black/20 p-3 text-xs text-zinc-300">
                            {jsonPreview(toolCall.args)}
                          </pre>
                        </div>
                      ) : null}
                      {toolCall.result ? (
                        <div>
                          <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                            Result
                          </p>
                          <pre className="mt-2 whitespace-pre-wrap rounded-md border border-white/10 bg-black/20 p-3 text-xs text-zinc-300">
                            {jsonPreview(toolCall.result)}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {artifacts.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Artifacts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {artifacts.map((artifact) => (
                  <div
                    className="rounded-md border border-white/10 bg-black/20 p-4"
                    key={artifact.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-white">{artifact.label}</p>
                      <StatusBadge status={artifact.status ?? "ready"} />
                    </div>
                    <div className="mt-2 space-y-2 text-sm leading-6 text-zinc-300">
                      {artifact.title !== artifact.label ? (
                        <p>{artifact.title}</p>
                      ) : null}
                      {artifact.type ? (
                        <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                          Type: {artifact.type}
                        </p>
                      ) : null}
                      {artifact.summary ? <p>{artifact.summary}</p> : null}
                      {artifact.url ? (
                        <Link
                          className="inline-flex text-sm text-emerald-100 underline-offset-4 hover:underline"
                          href={artifact.url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open artifact
                        </Link>
                      ) : (
                        <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-black/20 p-3 text-xs text-zinc-300">
                          {artifact.raw}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
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

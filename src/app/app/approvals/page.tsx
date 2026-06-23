import { ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { PendingSubmitButton } from "@/components/app/pending-submit-button";
import { StatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getCurrentUserContext } from "@/lib/app/context";
import { formatRelativeTime } from "@/lib/app/format";
import { getDb } from "@/lib/db";
import { updateApprovalStatus } from "../actions";

type SearchParams = Promise<{ workspace?: string }>;

function getApprovalTitle(requestedAction: unknown) {
  return requestedAction &&
    typeof requestedAction === "object" &&
    "title" in requestedAction
    ? String(requestedAction.title)
    : "Review requested action";
}

function getApprovalDescription(requestedAction: unknown) {
  return requestedAction &&
    typeof requestedAction === "object" &&
    "description" in requestedAction
    ? String(requestedAction.description)
    : "Decision required before this agent can use protected actions.";
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const [pendingApprovals, reviewedApprovals] =
    await getDb().$transaction([
      getDb().approvalRequest.findMany({
        where: {
          workspaceId: context.workspace.id,
          status: "PENDING",
        },
        include: {
          agent: { select: { name: true } },
          agentRun: { select: { id: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      getDb().approvalRequest.findMany({
        where: {
          workspaceId: context.workspace.id,
          status: { not: "PENDING" },
        },
        include: {
          agent: { select: { name: true } },
          agentRun: { select: { id: true } },
          reviewedBy: { select: { name: true, email: true } },
        },
        orderBy: { reviewedAt: "desc" },
        take: 10,
      }),
    ]);

  return (
    <>
      <PageHeader
        description="Review protected actions before agents modify external systems."
        eyebrow="Approvals"
        title="Human review queue"
      />
      <Card className="mb-5 border-amber-200/20 bg-amber-200/[0.06]">
        <CardHeader>
          <CardTitle className="text-amber-100">What approval does now</CardTitle>
          <CardDescription className="text-amber-100/80">
            Approval records a human decision and links it to the originating
            run. It does not execute Google Ads, Notion, Drive, or GA4 changes
            yet because live mutation tools are not enabled in this build.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Pending approvals</CardTitle>
          <CardDescription>
            Approving moves the item to decision history and opens the linked
            run with the recorded outcome.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pendingApprovals.length > 0 ? (
            <Table>
              <THead>
                <TR>
                  <TH>Action</TH>
                  <TH>Risk</TH>
                  <TH>Agent</TH>
                  <TH>Created</TH>
                  <TH>Decision</TH>
                </TR>
              </THead>
              <TBody>
                {pendingApprovals.map((approval) => {
                  const action = getApprovalTitle(approval.requestedAction);
                  const description = getApprovalDescription(
                    approval.requestedAction,
                  );

                  return (
                    <TR key={approval.id}>
                      <TD>
                        <div className="font-medium text-white">{action}</div>
                        <div className="mt-1 max-w-xl text-xs leading-5 text-zinc-500">
                          {description}
                        </div>
                      </TD>
                      <TD>
                        <StatusBadge status={approval.riskLevel} />
                      </TD>
                      <TD>{approval.agent.name}</TD>
                      <TD>{formatRelativeTime(approval.createdAt)}</TD>
                      <TD>
                        <div className="flex gap-2">
                          <form action={updateApprovalStatus}>
                            <input
                              name="approvalId"
                              type="hidden"
                              value={approval.id}
                            />
                            <input
                              name="workspaceId"
                              type="hidden"
                              value={context.workspace.id}
                            />
                            <input name="status" type="hidden" value="APPROVED" />
                            <PendingSubmitButton
                              pendingLabel="Approving..."
                              size="sm"
                              type="submit"
                            >
                              Approve
                            </PendingSubmitButton>
                          </form>
                          <form action={updateApprovalStatus}>
                            <input
                              name="approvalId"
                              type="hidden"
                              value={approval.id}
                            />
                            <input
                              name="workspaceId"
                              type="hidden"
                              value={context.workspace.id}
                            />
                            <input name="status" type="hidden" value="REJECTED" />
                            <PendingSubmitButton
                              pendingLabel="Rejecting..."
                              size="sm"
                              type="submit"
                              variant="secondary"
                            >
                              Reject
                            </PendingSubmitButton>
                          </form>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          ) : (
            <EmptyState
              description="Protected actions such as budget changes, destructive edits, and irreversible file operations will be queued here."
              icon={ClipboardCheck}
              title="No approvals waiting"
            />
          )}
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Decision history</CardTitle>
          <CardDescription>
            Recent approval decisions stay visible here so they do not disappear
            silently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reviewedApprovals.length > 0 ? (
            <Table>
              <THead>
                <TR>
                  <TH>Action</TH>
                  <TH>Status</TH>
                  <TH>Agent</TH>
                  <TH>Reviewed</TH>
                  <TH>Run</TH>
                </TR>
              </THead>
              <TBody>
                {reviewedApprovals.map((approval) => {
                  const action = getApprovalTitle(approval.requestedAction);
                  const reviewer =
                    approval.reviewedBy?.name ?? approval.reviewedBy?.email;

                  return (
                    <TR key={approval.id}>
                      <TD className="font-medium text-white">{action}</TD>
                      <TD>
                        <StatusBadge status={approval.status} />
                      </TD>
                      <TD>{approval.agent.name}</TD>
                      <TD>
                        {approval.reviewedAt
                          ? `${formatRelativeTime(approval.reviewedAt)}${reviewer ? ` by ${reviewer}` : ""}`
                          : "Not recorded"}
                      </TD>
                      <TD>
                        {approval.agentRun ? (
                          <Button asChild size="sm" variant="secondary">
                            <Link
                              href={`/app/runs/${approval.agentRun.id}?workspace=${context.workspace.id}`}
                            >
                              View run
                            </Link>
                          </Button>
                        ) : (
                          <span className="text-zinc-500">No run</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          ) : (
            <EmptyState
              description="Approved and rejected decisions will appear here after review."
              icon={ClipboardCheck}
              title="No decisions yet"
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

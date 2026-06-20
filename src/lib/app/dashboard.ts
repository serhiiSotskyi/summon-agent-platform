import { connectorCatalog } from "@/lib/connectors/catalog";
import { getDb } from "@/lib/db";

export async function getWorkspaceDashboard(workspaceId: string) {
  const db = getDb();

  const [
    agents,
    activeAgents,
    runs,
    pendingApprovals,
    credentials,
    recentRuns,
    approvals,
    hasSharedWorkspace,
    spend,
  ] = await Promise.all([
    db.agent.count({
      where: { workspaceId, status: { not: "DELETED" } },
    }),
    db.agent.count({
      where: { workspaceId, status: "ACTIVE" },
    }),
    db.agentRun.count({
      where: { agent: { workspaceId } },
    }),
    db.approvalRequest.count({
      where: { workspaceId, status: "PENDING" },
    }),
    db.connectorCredential.findMany({
      where: { workspaceId },
      select: {
        connectorType: true,
        status: true,
        displayName: true,
        updatedAt: true,
        lastHealthCheckAt: true,
      },
    }),
    db.agentRun.findMany({
      where: { agent: { workspaceId } },
      include: {
        agent: {
          select: {
            name: true,
          },
        },
        _count: {
          select: {
            artifacts: true,
            toolCalls: true,
          },
        },
      },
      orderBy: { triggeredAt: "desc" },
      take: 5,
    }),
    db.approvalRequest.findMany({
      where: { workspaceId, status: "PENDING" },
      include: {
        agent: {
          select: {
            name: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.workspace.count({
      where: { id: workspaceId, type: "SHARED" },
    }),
    db.agentRun.aggregate({
      where: {
        agent: { workspaceId },
        costEstimate: { not: null },
        triggeredAt: {
          gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
        },
      },
      _sum: {
        costEstimate: true,
      },
    }),
  ]);

  const connectorStatuses = connectorCatalog.map((connector) => {
    const credential = credentials.find(
      (item) => item.connectorType === connector.key,
    );

    return {
      ...connector,
      status: credential?.status ?? "MISSING",
      displayName: credential?.displayName,
      lastHealthCheckAt: credential?.lastHealthCheckAt,
    };
  });

  return {
    counts: {
      agents,
      activeAgents,
      runs,
      pendingApprovals,
      connectors: credentials.filter((item) => item.status === "ACTIVE").length,
      estimatedSpend30d: spend._sum.costEstimate?.toNumber() ?? 0,
    },
    setupChecklist: [
      {
        label: "Create a shared workspace",
        complete: hasSharedWorkspace > 0,
        href: "/app/onboarding",
      },
      {
        label: "Connect at least one tool",
        complete: credentials.some((item) => item.status === "ACTIVE"),
        href: "/app/connectors",
      },
      {
        label: "Create your first agent",
        complete: agents > 0,
        href: "/app/agents/new",
      },
      {
        label: "Run an agent",
        complete: runs > 0,
        href: "/app/agents",
      },
    ],
    connectorStatuses,
    recentRuns: recentRuns.map((run) => ({
      id: run.id,
      agentName: run.agent.name,
      status: run.status,
      triggerType: run.triggerType,
      triggeredAt: run.triggeredAt,
      summary: run.summary,
      artifacts: run._count.artifacts,
      toolCalls: run._count.toolCalls,
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      action:
        typeof approval.requestedAction === "object" &&
        approval.requestedAction &&
        "title" in approval.requestedAction
          ? String(approval.requestedAction.title)
          : "Review requested action",
      riskLevel: approval.riskLevel,
      agentName: approval.agent.name,
      createdAt: approval.createdAt,
    })),
  };
}

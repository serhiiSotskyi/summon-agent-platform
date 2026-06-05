import type { ConnectorKey } from "@/lib/connectors/catalog";

export const demoDashboard = {
  counts: {
    agents: 6,
    activeAgents: 4,
    runs: 38,
    pendingApprovals: 3,
    connectors: 4,
    estimatedSpend30d: 4.82,
  },
  recentRuns: [
    {
      id: "demo-run-1",
      agentName: "Paid acquisition pulse",
      status: "SUCCESS",
      triggerType: "SCHEDULED",
      triggeredAt: new Date(Date.now() - 1000 * 60 * 18),
      summary: "Spend stable; two campaigns need budget review.",
    },
    {
      id: "demo-run-2",
      agentName: "Notion client update drafter",
      status: "QUEUED",
      triggerType: "MANUAL",
      triggeredAt: new Date(Date.now() - 1000 * 60 * 4),
      summary: "Waiting for connector approval.",
    },
  ],
  approvals: [
    {
      id: "demo-approval-1",
      action: "Increase Brand Search budget by 8%",
      riskLevel: "PROTECTED",
      agentName: "Paid acquisition pulse",
      createdAt: new Date(Date.now() - 1000 * 60 * 9),
    },
    {
      id: "demo-approval-2",
      action: "Publish weekly client update to Notion",
      riskLevel: "MEDIUM",
      agentName: "Notion client update drafter",
      createdAt: new Date(Date.now() - 1000 * 60 * 24),
    },
  ],
};

export const demoAgents = [
  {
    id: "demo-agent-1",
    name: "Paid acquisition pulse",
    description: "Reviews Google Ads and GA4 movement every weekday morning.",
    status: "ACTIVE",
    triggerType: "SCHEDULED",
    llmProvider: "openai",
    llmModel: "gpt-4.1",
    connectorLabels: ["Google Ads", "GA4"],
    lastRun: new Date(Date.now() - 1000 * 60 * 18),
  },
  {
    id: "demo-agent-2",
    name: "Drive contract monitor",
    description: "Finds new contract files and drafts summaries for review.",
    status: "DRAFT",
    triggerType: "MANUAL",
    llmProvider: "openai",
    llmModel: "gpt-4.1",
    connectorLabels: ["Google Drive"],
    lastRun: null,
  },
];

export const demoConnectorStatus: Record<ConnectorKey, boolean> = {
  "google-ads": true,
  ga4: true,
  notion: true,
  "google-drive": true,
};

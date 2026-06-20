import { resolveMx, resolveTxt } from "node:dns/promises";
import type { Prisma } from "@prisma/client";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

export type ReadinessStatus = "READY" | "DEGRADED" | "BLOCKED";

export type ReadinessItem = {
  action?: string;
  detail: string;
  href?: string;
  key: string;
  status: ReadinessStatus;
  title: string;
};

export type WorkspaceReadiness = {
  checkedAt: string;
  items: ReadinessItem[];
  status: ReadinessStatus;
};

type StoredInviteDeliveryStatus = {
  provider?: unknown;
  reason?: unknown;
  sent?: unknown;
};

function combineReadinessStatus(items: ReadinessItem[]): ReadinessStatus {
  if (items.some((item) => item.status === "BLOCKED")) {
    return "BLOCKED";
  }

  if (items.some((item) => item.status === "DEGRADED")) {
    return "DEGRADED";
  }

  return "READY";
}

function parseInviteDeliveryStatus(
  value: Prisma.JsonValue | null,
): StoredInviteDeliveryStatus | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StoredInviteDeliveryStatus)
    : null;
}

function fromEmailDomain(from: string | undefined) {
  if (!from) {
    return null;
  }

  const emailMatch = from.match(/<[^@\s<>]+@([^>\s]+)>/);
  if (emailMatch?.[1]) {
    return emailMatch[1].toLowerCase();
  }

  const bareMatch = from.match(/^[^@\s<>]+@([^>\s<>]+)$/);
  return bareMatch?.[1]?.toLowerCase() ?? null;
}

async function hasTxtRecord(name: string, expectedPrefix?: string) {
  try {
    const records = await resolveTxt(name);
    const flattened = records.map((record) => record.join(""));
    return expectedPrefix
      ? flattened.some((record) => record.startsWith(expectedPrefix))
      : flattened.length > 0;
  } catch {
    return false;
  }
}

async function hasMxRecord(name: string, expectedHost: string) {
  try {
    const records = await resolveMx(name);
    return records.some(
      (record) => record.exchange.toLowerCase() === expectedHost.toLowerCase(),
    );
  } catch {
    return false;
  }
}

async function resendReadiness(workspaceId: string): Promise<ReadinessItem> {
  const apiKey = getEnv("RESEND_API_KEY");
  const from = getEnv("INVITE_FROM_EMAIL");
  if (!apiKey || !from) {
    return {
      action: "Add RESEND_API_KEY and INVITE_FROM_EMAIL to production before relying on email invitations.",
      detail: "Invite links still work manually, but email delivery is not configured.",
      key: "resend",
      status: "BLOCKED",
      title: "Invite email delivery",
    };
  }

  const latestInvitation = await getDb().workspaceInvitation.findFirst({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    select: { deliveryStatus: true },
  });
  const deliveryStatus = parseInviteDeliveryStatus(
    latestInvitation?.deliveryStatus ?? null,
  );
  if (deliveryStatus?.sent === true) {
    return {
      detail: "The latest invitation email was accepted by the email provider.",
      key: "resend",
      status: "READY",
      title: "Invite email delivery",
    };
  }

  const domain = fromEmailDomain(from);
  const dkimOk = domain
    ? await hasTxtRecord(`resend._domainkey.${domain}`, "p=")
    : false;
  const spfTxtOk = domain
    ? await hasTxtRecord(`send.${domain}`, "v=spf1 include:amazonses.com")
    : false;
  const spfMxOk = domain
    ? await hasMxRecord(
        `send.${domain}`,
        "feedback-smtp.eu-west-1.amazonses.com",
      )
    : false;
  const dnsOk = dkimOk && spfTxtOk && spfMxOk;
  const reason =
    typeof deliveryStatus?.reason === "string" ? deliveryStatus.reason : null;

  return {
    action: dnsOk
      ? "DNS records are present. Open Resend Domains and retry/complete verification for summon.co."
      : "Add or fix the Resend DKIM, send MX, and send TXT records in DNS, then retry verification in Resend.",
    detail: reason
      ? `Email sends are still rejected: ${reason}`
      : dnsOk
        ? "DNS records resolve publicly, but no successful provider delivery has been recorded yet."
        : "Email delivery is configured, but required DNS records are not all visible publicly.",
    href: "https://resend.com/domains",
    key: "resend",
    status: "DEGRADED",
    title: "Invite email delivery",
  };
}

function llmReadiness(): ReadinessItem {
  if (getEnv("OPENAI_API_KEY")) {
    return {
      detail: "OpenAI is configured for agent creation, tool planning, and run summaries.",
      key: "llm",
      status: "READY",
      title: "Default LLM provider",
    };
  }

  return {
    action: "Add OPENAI_API_KEY to production, or configure another provider as the default.",
    detail: "Agents can be created, but production runs will fail when the selected provider has no valid API key.",
    key: "llm",
    status: "BLOCKED",
    title: "Default LLM provider",
  };
}

async function connectorReadiness(workspaceId: string): Promise<ReadinessItem[]> {
  const credentials = await getDb().connectorCredential.findMany({
    where: { workspaceId },
    select: { connectorType: true },
  });
  const connected = new Set(credentials.map((credential) => credential.connectorType));

  const items: ReadinessItem[] = [
    {
      action: connected.has("notion")
        ? undefined
        : "Connect Notion so agents can search Summon Memory and create memory pages.",
      detail: connected.has("notion")
        ? "Notion is connected for workspace memory and write-back pages."
        : "Notion is not connected, so agents cannot use Summon Memory reliably.",
      key: "notion",
      status: connected.has("notion") ? "READY" : "BLOCKED",
      title: "Notion memory",
    },
    {
      action: connected.has("google-drive")
        ? undefined
        : "Connect Google Drive with write-capable scopes for Docs, Sheets, Slides, and Drive files.",
      detail: connected.has("google-drive")
        ? "Google Drive is connected for read/write run-owned file work."
        : "Google Drive is not connected, so agents cannot inspect or create Google outputs.",
      key: "google-drive",
      status: connected.has("google-drive") ? "READY" : "BLOCKED",
      title: "Google Drive workspace files",
    },
  ];

  if (connected.has("google-drive")) {
    items.push({
      action:
        "Open the Google Drive connector page for live Drive, Docs, Sheets, and Slides API probes.",
      detail:
        "Google Drive is connected. Native Docs/Sheets/Slides API readiness is checked on the Google Drive connector page to keep this settings page fast.",
      href:
        `/app/connectors/google-drive?workspace=${workspaceId}`,
      key: "google-workspace-apis",
      status: "DEGRADED",
      title: "Native Google Workspace APIs",
    });
  }

  if (!getEnv("GOOGLE_ADS_DEVELOPER_TOKEN")) {
    items.push({
      action:
        "Use Google Drive/Sheets/Notion budget trackers for now. Add a Google Ads developer token later for live Ads API reads.",
      detail: "Direct Google Ads API access is not enabled, but this is acceptable for the current Drive/Sheets-backed workflow.",
      key: "google-ads-api",
      status: "DEGRADED",
      title: "Google Ads direct API",
    });
  }

  return items;
}

export async function getWorkspaceReadiness(
  workspaceId: string,
): Promise<WorkspaceReadiness> {
  const items = [
    llmReadiness(),
    ...(await connectorReadiness(workspaceId)),
    await resendReadiness(workspaceId),
  ];

  return {
    checkedAt: new Date().toISOString(),
    items,
    status: combineReadinessStatus(items),
  };
}

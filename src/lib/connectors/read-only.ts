import type { ConnectorCredential } from "@prisma/client";
import { getConnector, type ConnectorKey } from "@/lib/connectors/catalog";
import {
  decryptConnectorCredentials,
  encryptConnectorCredentials,
} from "@/lib/connectors/credentials";
import { getDb } from "@/lib/db";
import { getEnv, requireEnv } from "@/lib/env";

type OAuthTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [key: string]: unknown;
};

type StoredCredentialPayload = {
  provider?: string;
  connectorType?: string;
  token?: OAuthTokenPayload;
  connectedAt?: string;
  [key: string]: unknown;
};

type RuntimeCredential = Pick<
  ConnectorCredential,
  "id" | "connectorType" | "displayName" | "encryptedCredentials" | "lastHealthCheckAt"
>;

export type ConnectorReadResult = {
  connectorType: string;
  connectorName: string;
  status: "success" | "blocked" | "error";
  summary: string;
  blockers: string[];
  records: unknown[];
  meta?: Record<string, string | number | boolean | null>;
};

export type ConnectorReadContext = {
  connectedTools: string[];
  missingTools: string[];
  results: ConnectorReadResult[];
  blockers: string[];
};

function connectorName(key: string) {
  return getConnector(key)?.name ?? key;
}

function blockedResult(connectorType: string, blockers: string[]): ConnectorReadResult {
  return {
    connectorType,
    connectorName: connectorName(connectorType),
    status: "blocked",
    summary: `${connectorName(connectorType)} needs setup before it can be read.`,
    blockers,
    records: [],
  };
}

function errorResult(connectorType: string, error: unknown): ConnectorReadResult {
  const message =
    error instanceof Error ? error.message : "Read-only connector call failed.";

  return {
    connectorType,
    connectorName: connectorName(connectorType),
    status: "error",
    summary: `${connectorName(connectorType)} read failed: ${message}`,
    blockers: [message],
    records: [],
  };
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function apiError(provider: string, response: Response, payload: unknown) {
  const detail =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
      ? payload.error.message
      : typeof payload === "string"
        ? payload.slice(0, 240)
        : response.statusText;

  return new Error(`${provider} returned ${response.status}: ${detail}`);
}

function trimText(value: string, maxLength = 3000) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function extractPlainText(value: unknown): string {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractPlainText).filter(Boolean).join(" ");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.plain_text === "string") {
      return record.plain_text;
    }

    if (record.title) {
      return extractPlainText(record.title);
    }

    if (record.rich_text) {
      return extractPlainText(record.rich_text);
    }
  }

  return "";
}

function extractNotionTitle(page: unknown) {
  if (!page || typeof page !== "object") {
    return "Untitled";
  }

  const record = page as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object") {
    for (const property of Object.values(record.properties)) {
      if (
        property &&
        typeof property === "object" &&
        "type" in property &&
        property.type === "title"
      ) {
        const title = extractPlainText((property as Record<string, unknown>).title);
        if (title) {
          return title;
        }
      }
    }
  }

  const title = extractPlainText(record.title);
  return title || "Untitled";
}

async function refreshGoogleAccessToken(credential: RuntimeCredential) {
  const payload = decryptConnectorCredentials<StoredCredentialPayload>(
    credential.encryptedCredentials,
  );
  const token = payload.token;

  if (!token?.access_token) {
    throw new Error(`${credential.displayName} does not include an access token.`);
  }

  if (!token.refresh_token) {
    return token.access_token;
  }

  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const refreshPayload = (await readJson(response)) as OAuthTokenPayload | null;

  if (!response.ok || !refreshPayload?.access_token) {
    throw apiError("Google token refresh", response, refreshPayload);
  }

  await getDb().connectorCredential.update({
    where: { id: credential.id },
    data: {
      encryptedCredentials: encryptConnectorCredentials({
        ...payload,
        token: {
          ...token,
          ...refreshPayload,
          refresh_token: token.refresh_token,
        },
      }),
      status: "ACTIVE",
      lastHealthCheckAt: new Date(),
    },
  });

  return refreshPayload.access_token;
}

function getNotionAccessToken(credential: RuntimeCredential) {
  const payload = decryptConnectorCredentials<StoredCredentialPayload>(
    credential.encryptedCredentials,
  );
  const accessToken = payload.token?.access_token;

  if (!accessToken) {
    throw new Error(`${credential.displayName} does not include an access token.`);
  }

  return accessToken;
}

async function resolveGa4PropertyId(accessToken: string) {
  const configuredPropertyId =
    getEnv("GA4_PROPERTY_ID") ?? getEnv("GOOGLE_ANALYTICS_PROPERTY_ID");

  if (configuredPropertyId) {
    return {
      propertyId: configuredPropertyId.replace(/^properties\//, ""),
      source: "env" as const,
      accountName: null,
      propertyName: null,
    };
  }

  const url = new URL("https://analyticsadmin.googleapis.com/v1alpha/accountSummaries");
  url.searchParams.set("pageSize", "50");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await readJson(response)) as
    | {
        accountSummaries?: Array<{
          displayName?: string;
          propertySummaries?: Array<{
            displayName?: string;
            property?: string;
          }>;
        }>;
      }
    | null;

  if (!response.ok) {
    throw apiError("GA4 Admin API", response, payload);
  }

  for (const accountSummary of payload?.accountSummaries ?? []) {
    for (const propertySummary of accountSummary.propertySummaries ?? []) {
      if (propertySummary.property) {
        return {
          propertyId: propertySummary.property.replace(/^properties\//, ""),
          source: "auto" as const,
          accountName: accountSummary.displayName ?? null,
          propertyName: propertySummary.displayName ?? null,
        };
      }
    }
  }

  return null;
}

async function resolveGoogleAdsCustomerId({
  accessToken,
  apiVersion,
  developerToken,
}: {
  accessToken: string;
  apiVersion: string;
  developerToken: string;
}) {
  const configuredCustomerId = getEnv("GOOGLE_ADS_CUSTOMER_ID");

  if (configuredCustomerId) {
    return {
      customerId: configuredCustomerId.replace(/\D/g, ""),
      source: "env" as const,
      accessibleCustomers: [],
    };
  }

  const response = await fetch(
    `https://googleads.googleapis.com/${apiVersion}/customers:listAccessibleCustomers`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": developerToken,
      },
    },
  );
  const payload = (await readJson(response)) as
    | { resourceNames?: string[] }
    | Record<string, unknown>
    | null;

  if (!response.ok) {
    throw apiError("Google Ads accessible customers", response, payload);
  }

  const accessibleCustomers =
    payload && "resourceNames" in payload && Array.isArray(payload.resourceNames)
      ? payload.resourceNames
          .filter((resourceName): resourceName is string => typeof resourceName === "string")
          .map((resourceName) => resourceName.replace(/^customers\//, "").replace(/\D/g, ""))
          .filter(Boolean)
      : [];

  const customerId = accessibleCustomers[0] ?? null;

  return {
    customerId,
    source: customerId ? ("auto" as const) : ("none" as const),
    accessibleCustomers,
  };
}

async function readGoogleDrive(credential: RuntimeCredential): Promise<ConnectorReadResult> {
  const accessToken = await refreshGoogleAccessToken(credential);
  const folderId = getEnv("GOOGLE_DRIVE_FOLDER_ID");
  const query =
    getEnv("GOOGLE_DRIVE_QUERY") ??
    (folderId
      ? `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`
      : "(name contains 'budget' or name contains 'tracker') and trashed = false");
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", query);
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,modifiedTime,webViewLink,size)",
  );

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = (await readJson(response)) as
    | { files?: Array<Record<string, unknown>> }
    | null;

  if (!response.ok) {
    throw apiError("Google Drive", response, payload);
  }

  const files = payload?.files ?? [];
  const records = await Promise.all(
    files.slice(0, 5).map(async (file) => {
      const id = typeof file.id === "string" ? file.id : null;
      const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
      let textPreview: string | null = null;
      let exportError: string | null = null;

      if (id && mimeType === "application/vnd.google-apps.document") {
        const exportUrl = new URL(
          `https://www.googleapis.com/drive/v3/files/${id}/export`,
        );
        exportUrl.searchParams.set("mimeType", "text/plain");
        const exportResponse = await fetch(exportUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (exportResponse.ok) {
          textPreview = trimText(await exportResponse.text(), 1200);
        } else {
          exportError = `Document export failed with ${exportResponse.status}.`;
        }
      }

      if (id && mimeType === "application/vnd.google-apps.spreadsheet") {
        const exportUrl = new URL(
          `https://www.googleapis.com/drive/v3/files/${id}/export`,
        );
        exportUrl.searchParams.set("mimeType", "text/csv");
        const exportResponse = await fetch(exportUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (exportResponse.ok) {
          textPreview = trimText(await exportResponse.text(), 1200);
        } else {
          exportError = `Spreadsheet export failed with ${exportResponse.status}.`;
        }
      }

      return {
        id,
        name: file.name ?? "Untitled",
        mimeType,
        modifiedTime: file.modifiedTime ?? null,
        webViewLink: file.webViewLink ?? null,
        textPreview,
        exportError,
      };
    }),
  );

  return {
    connectorType: "google-drive",
    connectorName: "Google Drive",
    status: "success",
    summary:
      records.length > 0
        ? `Found ${records.length} relevant Drive file${records.length === 1 ? "" : "s"}.`
        : "No matching Drive files were found for the current query.",
    blockers: [],
    records,
    meta: { query },
  };
}

async function readGa4(credential: RuntimeCredential): Promise<ConnectorReadResult> {
  const accessToken = await refreshGoogleAccessToken(credential);
  const property = await resolveGa4PropertyId(accessToken);

  if (!property) {
    return blockedResult("ga4", [
      "No GA4 properties were found for the authorized Google account.",
    ]);
  }

  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${property.propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "eventCount" },
        ],
        limit: "10",
      }),
    },
  );
  const payload = (await readJson(response)) as
    | {
        dimensionHeaders?: Array<{ name?: string }>;
        metricHeaders?: Array<{ name?: string }>;
        rows?: Array<{
          dimensionValues?: Array<{ value?: string }>;
          metricValues?: Array<{ value?: string }>;
        }>;
      }
    | null;

  if (!response.ok) {
    throw apiError("GA4 Data API", response, payload);
  }

  const metricNames = payload?.metricHeaders?.map((header) => header.name ?? "") ?? [];
  const records =
    payload?.rows?.map((row) => ({
      date: row.dimensionValues?.[0]?.value ?? null,
      metrics: Object.fromEntries(
        metricNames.map((name, index) => [
          name,
          row.metricValues?.[index]?.value ?? null,
        ]),
      ),
    })) ?? [];

  return {
    connectorType: "ga4",
    connectorName: "GA4",
    status: "success",
    summary:
      records.length > 0
        ? `Fetched GA4 daily metrics for ${records.length} day${records.length === 1 ? "" : "s"}.`
        : "GA4 returned no rows for the last 7 days.",
    blockers: [],
    records,
    meta: {
      propertyId: property.propertyId,
      propertySource: property.source,
      accountName: property.accountName,
      propertyName: property.propertyName,
    },
  };
}

async function readGoogleAds(credential: RuntimeCredential): Promise<ConnectorReadResult> {
  const developerToken = getEnv("GOOGLE_ADS_DEVELOPER_TOKEN");

  if (!developerToken) {
    return blockedResult("google-ads", [
      "Add GOOGLE_ADS_DEVELOPER_TOKEN once for the backend before the worker can query Google Ads performance. The customer account can be auto-detected from the authorized Google account.",
    ]);
  }

  const accessToken = await refreshGoogleAccessToken(credential);
  const apiVersion = getEnv("GOOGLE_ADS_API_VERSION") ?? "v22";
  const customer = await resolveGoogleAdsCustomerId({
    accessToken,
    apiVersion,
    developerToken,
  });

  if (!customer.customerId) {
    return blockedResult("google-ads", [
      "No accessible Google Ads customers were found for the authorized Google account.",
    ]);
  }

  const response = await fetch(
    `https://googleads.googleapis.com/${apiVersion}/customers/${customer.customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "developer-token": developerToken,
        ...(getEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID")
          ? {
              "login-customer-id": getEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID")!.replace(
                /\D/g,
                "",
              ),
            }
          : {}),
      },
      body: JSON.stringify({
        query: [
          "SELECT",
          "campaign.id, campaign.name, campaign.status,",
          "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions",
          "FROM campaign",
          "WHERE segments.date DURING LAST_7_DAYS",
          "ORDER BY metrics.cost_micros DESC",
          "LIMIT 20",
        ].join(" "),
      }),
    },
  );
  const payload = (await readJson(response)) as
    | Array<{ results?: Array<Record<string, unknown>> }>
    | Record<string, unknown>
    | null;

  if (!response.ok) {
    throw apiError("Google Ads API", response, payload);
  }

  const rows = Array.isArray(payload)
    ? payload.flatMap((chunk) => chunk.results ?? [])
    : [];
  const records = rows.map((row) => ({
    campaign: row.campaign ?? null,
    metrics: row.metrics ?? null,
  }));

  return {
    connectorType: "google-ads",
    connectorName: "Google Ads",
    status: "success",
    summary:
      records.length > 0
        ? `Fetched Google Ads performance for ${records.length} campaign${records.length === 1 ? "" : "s"}.`
        : "Google Ads returned no campaign rows for the last 7 days.",
    blockers: [],
    records,
    meta: {
      customerId: customer.customerId,
      customerSource: customer.source,
      accessibleCustomerCount: customer.accessibleCustomers.length,
      apiVersion,
    },
  };
}

async function readNotion(credential: RuntimeCredential): Promise<ConnectorReadResult> {
  const accessToken = getNotionAccessToken(credential);
  const query = getEnv("NOTION_SEARCH_QUERY") ?? "budget";
  const response = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      query,
      page_size: 10,
      sort: {
        direction: "descending",
        timestamp: "last_edited_time",
      },
    }),
  });
  const payload = (await readJson(response)) as
    | { results?: Array<Record<string, unknown>> }
    | null;

  if (!response.ok) {
    throw apiError("Notion", response, payload);
  }

  const records =
    payload?.results?.map((item) => ({
      object: item.object ?? null,
      id: item.id ?? null,
      title: extractNotionTitle(item),
      url: item.url ?? null,
      lastEditedTime: item.last_edited_time ?? null,
    })) ?? [];

  return {
    connectorType: "notion",
    connectorName: "Notion",
    status: "success",
    summary:
      records.length > 0
        ? `Found ${records.length} Notion result${records.length === 1 ? "" : "s"}.`
        : "No matching Notion pages or databases were found.",
    blockers: [],
    records,
    meta: { query },
  };
}

async function readConnector(
  connectorType: string,
  credential?: RuntimeCredential,
): Promise<ConnectorReadResult> {
  if (!credential) {
    return blockedResult(connectorType, [
      `${connectorName(connectorType)} is not connected for this workspace.`,
    ]);
  }

  try {
    if (connectorType === "google-drive") {
      return await readGoogleDrive(credential);
    }

    if (connectorType === "ga4") {
      return await readGa4(credential);
    }

    if (connectorType === "google-ads") {
      return await readGoogleAds(credential);
    }

    if (connectorType === "notion") {
      return await readNotion(credential);
    }

    return blockedResult(connectorType, [
      `${connectorName(connectorType)} does not have a read-only runtime yet.`,
    ]);
  } catch (error) {
    return errorResult(connectorType, error);
  }
}

export async function collectReadOnlyConnectorContext({
  tools,
  workspaceId,
}: {
  tools: string[];
  workspaceId: string;
}): Promise<ConnectorReadContext> {
  const uniqueTools = Array.from(
    new Set(
      tools.filter((tool): tool is ConnectorKey =>
        Boolean(getConnector(tool)),
      ),
    ),
  );
  const credentials = await getDb().connectorCredential.findMany({
    where: {
      workspaceId,
      connectorType: { in: uniqueTools },
      status: "ACTIVE",
    },
    select: {
      id: true,
      connectorType: true,
      displayName: true,
      encryptedCredentials: true,
      lastHealthCheckAt: true,
    },
  });
  const credentialsByType = new Map(
    credentials.map((credential) => [credential.connectorType, credential]),
  );
  const results = await Promise.all(
    uniqueTools.map((tool) => readConnector(tool, credentialsByType.get(tool))),
  );
  const connectedTools = credentials.map((credential) => credential.connectorType);
  const missingTools = uniqueTools.filter((tool) => !credentialsByType.has(tool));

  return {
    connectedTools,
    missingTools,
    results,
    blockers: results.flatMap((result) => result.blockers),
  };
}

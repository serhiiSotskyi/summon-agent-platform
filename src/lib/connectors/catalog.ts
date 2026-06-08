export type ConnectorKey = "google-ads" | "ga4" | "notion" | "google-drive";

export type ConnectorCatalogItem = {
  key: ConnectorKey;
  name: string;
  provider: "google" | "notion";
  summary: string;
  scopes: string[];
  accessModeLabel: string;
  accessModeDescription: string;
  oauthPath: string;
};

export const connectorCatalog: ConnectorCatalogItem[] = [
  {
    key: "google-ads",
    name: "Google Ads",
    provider: "google",
    summary: "Read-only campaign, budget, keyword, and account performance reporting.",
    scopes: ["https://www.googleapis.com/auth/adwords"],
    accessModeLabel: "Read-only enforced by Summon",
    accessModeDescription:
      "Google Ads exposes one OAuth scope for API access. Summon only uses reporting/search endpoints and never sends mutate requests.",
    oauthPath: "/api/connectors/google/start?source=google-ads",
  },
  {
    key: "ga4",
    name: "GA4",
    provider: "google",
    summary: "Read-only analytics reporting, audience discovery, and conversion insights.",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    accessModeLabel: "Read-only OAuth",
    accessModeDescription:
      "Requests only the Google Analytics read-only scope for reporting data.",
    oauthPath: "/api/connectors/google/start?source=ga4",
  },
  {
    key: "notion",
    name: "Notion",
    provider: "notion",
    summary: "Workspace pages, databases, meeting notes, and research docs.",
    scopes: [],
    accessModeLabel: "Selected Notion access",
    accessModeDescription:
      "Notion access is controlled by the pages and capabilities selected in the Notion integration.",
    oauthPath: "/api/connectors/notion/start",
  },
  {
    key: "google-drive",
    name: "Google Drive",
    provider: "google",
    summary: "Read and write Docs, Sheets, Slides, folders, and Drive files.",
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive",
    ],
    accessModeLabel: "Write-capable OAuth",
    accessModeDescription:
      "Requests write-capable access so agents can read, copy, create, and update Drive files when policy allows it.",
    oauthPath: "/api/connectors/google/start?source=google-drive",
  },
];

export function getConnector(key: string) {
  return connectorCatalog.find((connector) => connector.key === key);
}

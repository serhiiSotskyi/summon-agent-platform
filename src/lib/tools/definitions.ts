import { connectorCatalog } from "@/lib/connectors/catalog";

const GENERIC_AGENT_TOOL_BASE = [
  {
    key: "python.run",
    name: "Python sandbox",
    summary:
      "Run uploaded or generated Python in the run workspace and return stdout, stderr, JSON, and generated files.",
    category: "Sandbox",
  },
  {
    key: "google.drive.copyFile",
    name: "Copy Drive file",
    summary:
      "Copy a Google Drive file, including native Slides, Sheets, and Docs templates, into a run-owned output.",
    category: "Google Drive",
  },
  {
    key: "google.drive.createTextFile",
    name: "Create Drive text file",
    summary:
      "Create a new text, JSON, CSV, or Markdown file in Google Drive.",
    category: "Google Drive",
  },
  {
    key: "google.drive.uploadArtifact",
    name: "Upload generated artifact",
    summary:
      "Upload a sandbox-generated file, such as a chart image or report asset, to Google Drive so it can be linked or inserted into generated outputs.",
    category: "Google Drive",
  },
  {
    key: "google.docs.createDocument",
    name: "Create Google Doc",
    summary:
      "Create a new native Google Doc as a run-owned editable output.",
    category: "Google Docs",
  },
  {
    key: "google.docs.readText",
    name: "Read Google Doc text",
    summary:
      "Read document text, paragraphs, and basic tables from a Google Doc.",
    category: "Google Docs",
  },
  {
    key: "google.docs.replaceText",
    name: "Replace text in generated Google Doc",
    summary:
      "Replace placeholder text in a Google Doc created or copied by the current run.",
    category: "Google Docs",
  },
  {
    key: "google.docs.batchUpdate",
    name: "Docs batch update",
    summary:
      "Run raw Google Docs batchUpdate requests against a Doc created or copied by the current run.",
    category: "Google Docs",
  },
  {
    key: "google.sheets.readRange",
    name: "Read Google Sheet range",
    summary: "Read values from a Google Sheets range.",
    category: "Google Sheets",
  },
  {
    key: "google.sheets.createSpreadsheet",
    name: "Create Google Sheet",
    summary:
      "Create a new native Google Sheet as a run-owned editable output, optionally seeded with rows.",
    category: "Google Sheets",
  },
  {
    key: "google.sheets.updateRange",
    name: "Update generated Google Sheet",
    summary:
      "Update cells in a Sheet created or copied by the current run. Existing external Sheets are blocked for approval.",
    category: "Google Sheets",
  },
  {
    key: "google.slides.copyTemplate",
    name: "Copy Slides template",
    summary:
      "Copy a Google Slides template/reference deck into a run-owned editable deck.",
    category: "Google Slides",
  },
  {
    key: "google.slides.readText",
    name: "Read Slides text",
    summary:
      "Read slide/object text from a Google Slides deck so the agent can target precise template replacements.",
    category: "Google Slides",
  },
  {
    key: "google.slides.inspectTemplate",
    name: "Inspect Slides template",
    summary:
      "Inspect a Google Slides deck map with slide IDs, element IDs, text boxes, tables, images/charts, layout hints, and slide classifications.",
    category: "Google Slides",
  },
  {
    key: "google.slides.updateText",
    name: "Update slide text element",
    summary:
      "Replace the full text in one text box or shape in a run-owned Google Slides deck using its element ID.",
    category: "Google Slides",
  },
  {
    key: "google.slides.updateTableCell",
    name: "Update slide table cell",
    summary:
      "Replace the full text in one table cell in a run-owned Google Slides deck using table element ID, row, and column.",
    category: "Google Slides",
  },
  {
    key: "google.slides.replaceText",
    name: "Replace text in generated Slides",
    summary:
      "Replace placeholder text in a Google Slides deck created or copied by the current run.",
    category: "Google Slides",
  },
  {
    key: "google.slides.batchUpdate",
    name: "Slides batch update",
    summary:
      "Run raw Google Slides batchUpdate requests against a deck created or copied by the current run.",
    category: "Google Slides",
  },
  {
    key: "google.slides.auditDeck",
    name: "Audit generated Slides deck",
    summary:
      "Audit a generated deck against report data and target market/client to flag stale template content, missing KPI values, and slides needing review.",
    category: "Google Slides",
  },
  {
    key: "notion.createPage",
    name: "Create Notion memory page",
    summary:
      "Create a new Notion page with the run summary, artifacts, and links.",
    category: "Notion",
  },
] as const;

export type GenericAgentToolKey = (typeof GENERIC_AGENT_TOOL_BASE)[number]["key"];

export type ToolRiskLevel =
  | "read"
  | "sandbox"
  | "run_owned_write"
  | "review";

type ToolPolicy = {
  approvalPolicy: string;
  authRequirement: string;
  retryPolicy: string;
  riskLevel: ToolRiskLevel;
  timeoutMs: number;
};

const sandboxPolicy = {
  approvalPolicy:
    "No approval required. Code runs only inside the scoped sandbox workspace.",
  authRequirement: "Uploaded/generated code only; no external connector auth.",
  retryPolicy: "No in-run retry. The worker job can retry failed runs.",
  riskLevel: "sandbox",
  timeoutMs: 30_000,
} satisfies ToolPolicy;

const googleReadPolicy = {
  approvalPolicy: "No approval required for reads.",
  authRequirement: "Active Google Drive workspace credential.",
  retryPolicy: "No in-run retry. The worker job can retry failed runs.",
  riskLevel: "read",
  timeoutMs: 45_000,
} satisfies ToolPolicy;

const googleRunOwnedWritePolicy = {
  approvalPolicy:
    "No approval required for creating/copying files or editing run-owned files created/copied by this run. Existing external files remain protected.",
  authRequirement: "Active Google Drive workspace credential with write scopes.",
  retryPolicy: "No in-run retry. The worker job can retry failed runs.",
  riskLevel: "run_owned_write",
  timeoutMs: 45_000,
} satisfies ToolPolicy;

const googleReviewPolicy = {
  approvalPolicy: "No approval required. This audits generated run-owned output.",
  authRequirement: "Active Google Drive workspace credential.",
  retryPolicy: "No retry required; rerun after fixing flagged output.",
  riskLevel: "review",
  timeoutMs: 45_000,
} satisfies ToolPolicy;

const notionWritePolicy = {
  approvalPolicy:
    "No approval required for creating a new memory page with run output, evidence, links, and caveats.",
  authRequirement: "Active Notion workspace credential with page creation access.",
  retryPolicy: "No in-run retry. The worker job can retry failed runs.",
  riskLevel: "run_owned_write",
  timeoutMs: 45_000,
} satisfies ToolPolicy;

const TOOL_POLICIES = {
  "python.run": sandboxPolicy,
  "google.drive.copyFile": googleRunOwnedWritePolicy,
  "google.drive.createTextFile": googleRunOwnedWritePolicy,
  "google.drive.uploadArtifact": googleRunOwnedWritePolicy,
  "google.docs.createDocument": googleRunOwnedWritePolicy,
  "google.docs.readText": googleReadPolicy,
  "google.docs.replaceText": googleRunOwnedWritePolicy,
  "google.docs.batchUpdate": googleRunOwnedWritePolicy,
  "google.sheets.readRange": googleReadPolicy,
  "google.sheets.createSpreadsheet": googleRunOwnedWritePolicy,
  "google.sheets.updateRange": googleRunOwnedWritePolicy,
  "google.slides.copyTemplate": googleRunOwnedWritePolicy,
  "google.slides.readText": googleReadPolicy,
  "google.slides.inspectTemplate": googleReadPolicy,
  "google.slides.updateText": googleRunOwnedWritePolicy,
  "google.slides.updateTableCell": googleRunOwnedWritePolicy,
  "google.slides.replaceText": googleRunOwnedWritePolicy,
  "google.slides.batchUpdate": googleRunOwnedWritePolicy,
  "google.slides.auditDeck": googleReviewPolicy,
  "notion.createPage": notionWritePolicy,
} satisfies Record<GenericAgentToolKey, ToolPolicy>;

export const GENERIC_AGENT_TOOLS = GENERIC_AGENT_TOOL_BASE.map((tool) => ({
  ...tool,
  ...TOOL_POLICIES[tool.key],
}));

export type GenericAgentTool = (typeof GENERIC_AGENT_TOOLS)[number];

export const DEFAULT_AGENT_TOOL_KEYS = [
  ...connectorCatalog.map((connector) => connector.key),
  ...GENERIC_AGENT_TOOLS.map((tool) => tool.key),
];

export function isGenericAgentToolKey(value: string): value is GenericAgentToolKey {
  return GENERIC_AGENT_TOOLS.some((tool) => tool.key === value);
}

export function genericToolDefinition(key: string) {
  return GENERIC_AGENT_TOOLS.find((tool) => tool.key === key);
}

function addIfMissing(tools: string[], tool: string) {
  if (!tools.includes(tool)) {
    tools.push(tool);
  }
}

function hasAnyToolPrefix(tools: string[], prefix: string) {
  return tools.some((tool) => tool.startsWith(prefix));
}

function hasAnyTool(tools: string[], candidates: string[]) {
  return candidates.some((tool) => tools.includes(tool));
}

export function normalizeAgentToolSelection(selectedTools: string[]) {
  const tools = [...DEFAULT_AGENT_TOOL_KEYS, ...selectedTools].filter(
    (tool, index, all) => {
      return typeof tool === "string" && tool.trim() && all.indexOf(tool) === index;
    },
  );

  const usesGoogleDrive =
    tools.includes("google-drive") ||
    hasAnyToolPrefix(tools, "google.drive.") ||
    hasAnyToolPrefix(tools, "google.docs.") ||
    hasAnyToolPrefix(tools, "google.sheets.") ||
    hasAnyToolPrefix(tools, "google.slides.");

  if (usesGoogleDrive) {
    addIfMissing(tools, "google-drive");
  }

  if (tools.includes("notion.createPage")) {
    addIfMissing(tools, "notion");
  }

  const usesSlides = hasAnyToolPrefix(tools, "google.slides.");
  if (usesSlides) {
    addIfMissing(tools, "google.slides.readText");
    addIfMissing(tools, "google.slides.inspectTemplate");
  }

  const writesSlides = hasAnyTool(tools, [
    "google.slides.copyTemplate",
    "google.slides.replaceText",
    "google.slides.updateText",
    "google.slides.updateTableCell",
    "google.slides.batchUpdate",
  ]);

  if (writesSlides) {
    addIfMissing(tools, "google.slides.auditDeck");
  }

  if (tools.includes("python.run") && usesSlides) {
    addIfMissing(tools, "google.drive.uploadArtifact");
    addIfMissing(tools, "google.slides.batchUpdate");
  }

  const usesDocs = hasAnyToolPrefix(tools, "google.docs.");
  if (usesDocs) {
    addIfMissing(tools, "google.docs.readText");
  }

  return tools;
}

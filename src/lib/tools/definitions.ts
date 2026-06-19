export const GENERIC_AGENT_TOOLS = [
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

export type GenericAgentToolKey = (typeof GENERIC_AGENT_TOOLS)[number]["key"];

export function isGenericAgentToolKey(value: string): value is GenericAgentToolKey {
  return GENERIC_AGENT_TOOLS.some((tool) => tool.key === value);
}

export function genericToolDefinition(key: string) {
  return GENERIC_AGENT_TOOLS.find((tool) => tool.key === key);
}

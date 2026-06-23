import type { ConnectorCredential } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { decryptConnectorCredentials, encryptConnectorCredentials } from "@/lib/connectors/credentials";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";

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
  "id" | "connectorType" | "displayName" | "encryptedCredentials"
>;

type NotionRichText = {
  type: "text";
  text: {
    content: string;
    link?: {
      url: string;
    };
  };
};

type NotionBlock = {
  object: "block";
  type: "paragraph" | "heading_1" | "heading_2" | "bulleted_list_item";
  paragraph?: {
    rich_text: NotionRichText[];
  };
  heading_1?: {
    rich_text: NotionRichText[];
  };
  heading_2?: {
    rich_text: NotionRichText[];
  };
  bulleted_list_item?: {
    rich_text: NotionRichText[];
  };
};

type NotionMemoryInput = {
  workspaceId: string;
  runId: string;
  runSummary: string | null;
  agentName?: string | null;
  runOutput?: unknown;
  parentPageId?: string;
  memoryTitle?: string;
};

type NotionMemoryResult = {
  pageId: string;
  pageUrl: string | null;
  createdAt: string;
};

type GoogleSlidesImportInput = {
  workspaceId: string;
  fileName: string;
  pptx: Buffer | Uint8Array | ArrayBuffer;
  slideName?: string;
  folderId?: string | null;
  connectorType?: string;
};

type GoogleDriveBinaryUploadInput = {
  workspaceId: string;
  name: string;
  content: Buffer | Uint8Array | ArrayBuffer | string;
  mimeType: string;
  parentFolderId?: string | null;
  makePublic?: boolean;
};

type GoogleSlidesImportResult = {
  fileId: string;
  fileName: string;
  webViewLink: string | null;
  webContentLink: string | null;
  mimeType: string;
};

function asObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

type GoogleDriveFileResult = {
  fileId: string;
  fileName: string;
  mimeType: string | null;
  webViewLink: string | null;
  mode?: string;
};

type GoogleSlidesTextElement = {
  objectId: string | null;
  text: string;
  source: "shape" | "table_cell";
  size?: unknown;
  transform?: unknown;
  rowIndex?: number;
  columnIndex?: number;
};

const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
const GOOGLE_DOCS_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEETS_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const GOOGLE_SCOPE_WARNING =
  "The Google credential does not include Docs/Sheets/Slides write scopes.";
const NOTION_API_VERSION = "2022-06-28";
const MAX_BLOCK_TEXT_LENGTH = 1800;

function normalizeBinaryData(input: Buffer | Uint8Array | ArrayBuffer | string) {
  if (typeof input === "string") {
    return Buffer.from(input, "utf8");
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }

  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }

  return input;
}

function toMultipartBody(parts: Array<{ headers: string; body: string | Buffer }>) {
  const boundary = `----summon-${Date.now()}-${randomBytes(8).toString("hex")}`;
  const lines: Buffer[] = [];

  for (const part of parts) {
    lines.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    lines.push(Buffer.from(part.headers, "utf8"));
    lines.push(Buffer.from("\r\n\r\n", "utf8"));
    lines.push(
      typeof part.body === "string" ? Buffer.from(part.body, "utf8") : part.body,
    );
    lines.push(Buffer.from("\r\n", "utf8"));
  }

  lines.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { boundary, body: Buffer.concat(lines) };
}

type ReadArtifactResult = {
  mode?: string;
  requestedTools: string[];
  connectedTools: string[];
  missingTools: string[];
  blockers: string[];
  text: string | null;
  connectorResults: Record<string, unknown>[];
};

function chunkText(value: string, size = MAX_BLOCK_TEXT_LENGTH) {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < trimmed.length; index += size) {
    chunks.push(trimmed.slice(index, index + size));
  }

  return chunks;
}

function buildNotionText(value: string, link?: string): NotionRichText[] {
  const chunks = chunkText(value, 1900);
  if (chunks.length === 0) {
    return [];
  }

  return chunks.map((chunk, chunkIndex) => ({
    type: "text",
    text: {
      content: chunk,
      ...(chunkIndex === 0 && link ? { link: { url: link } } : {}),
    },
  }));
}

function paragraphBlock(text: string, link?: string): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: buildNotionText(text, link),
    },
  };
}

function heading1Block(text: string): NotionBlock {
  return {
    object: "block",
    type: "heading_1",
    heading_1: {
      rich_text: buildNotionText(text),
    },
  };
}

function heading2Block(text: string): NotionBlock {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: buildNotionText(text),
    },
  };
}

function bulletItems(values: string[]): NotionBlock[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: buildNotionText(value),
      },
    }));
}

function hasArrayOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readJson(response: Response) {
  return response.text().then((text) => {
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
}

async function apiErrorMessage(
  provider: string,
  response: Response,
  payload: unknown,
) {
  if (typeof payload === "string") {
    return `${provider} API error ${response.status}: ${payload.slice(0, 260)}`;
  }

  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object"
  ) {
    const error = payload.error as { message?: string; code?: string | number };
    const details = error.message ?? JSON.stringify(error).slice(0, 260);
    return `${provider} API error ${response.status}: ${details}`;
  }

  return `${provider} API error ${response.status}: ${response.statusText}`;
}

function isGoogleApiDisabledError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /has not been used|disabled|accessNotConfigured|SERVICE_DISABLED/i.test(
    message,
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToGoogleDocHtml(input: { title?: string; text: string }) {
  const title = input.title ? `<h1>${escapeHtml(input.title)}</h1>` : "";
  const body = input.text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    "</head>",
    "<body>",
    title,
    body || "<p></p>",
    "</body>",
    "</html>",
  ].join("\n");
}

function csvCell(value: unknown) {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function rowsToCsv(rows: unknown[][]) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value !== "") || rows.length === 0) {
    rows.push(row);
  }

  return rows;
}

function columnToIndex(column: string) {
  return column
    .toUpperCase()
    .split("")
    .reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function parseA1Range(range: string) {
  const bareRange = range.split("!").pop()?.trim() || "A1";
  const match = bareRange.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) {
    return null;
  }

  return {
    startColumn: columnToIndex(match[1]),
    startRow: Number(match[2]) - 1,
    endColumn: match[3] ? columnToIndex(match[3]) : undefined,
    endRow: match[4] ? Number(match[4]) - 1 : undefined,
  };
}

function readRowsRange(rows: string[][], range: string) {
  const parsed = parseA1Range(range);
  if (!parsed) {
    return rows;
  }

  const endRow = parsed.endRow ?? parsed.startRow;
  const endColumn = parsed.endColumn ?? parsed.startColumn;

  return rows
    .slice(parsed.startRow, endRow + 1)
    .map((row) => row.slice(parsed.startColumn, endColumn + 1));
}

function writeRowsRange(rows: string[][], range: string, values: unknown[][]) {
  const parsed = parseA1Range(range);
  if (!parsed) {
    return rows;
  }

  const nextRows = rows.map((row) => [...row]);
  values.forEach((valueRow, rowOffset) => {
    const targetRowIndex = parsed.startRow + rowOffset;
    while (nextRows.length <= targetRowIndex) {
      nextRows.push([]);
    }

    valueRow.forEach((value, columnOffset) => {
      const targetColumnIndex = parsed.startColumn + columnOffset;
      while (nextRows[targetRowIndex].length <= targetColumnIndex) {
        nextRows[targetRowIndex].push("");
      }

      nextRows[targetRowIndex][targetColumnIndex] =
        value === null || value === undefined ? "" : String(value);
    });
  });

  return nextRows;
}

async function getWorkspaceConnectorCredential(
  workspaceId: string,
  connectorType: string,
) {
  return getDb().connectorCredential.findFirst({
    where: {
      workspaceId,
      connectorType,
    },
  });
}

function getCredentialPayload(credential: RuntimeCredential): StoredCredentialPayload {
  return decryptConnectorCredentials<StoredCredentialPayload>(
    credential.encryptedCredentials,
  );
}

function assertNotionAccess(payload: StoredCredentialPayload) {
  const accessToken = payload.token?.access_token;
  if (!accessToken) {
    throw new Error("The Notion credential is missing an access token.");
  }

  return accessToken;
}

async function refreshGoogleAccessToken(credential: RuntimeCredential) {
  const payload = getCredentialPayload(credential);
  const token = payload.token;

  if (!token?.access_token) {
    throw new Error(
      `${credential.displayName} does not include a Google access token.`,
    );
  }

  if (!token.refresh_token) {
    return token.access_token;
  }

  const body = new URLSearchParams({
    client_id: getEnv("GOOGLE_OAUTH_CLIENT_ID")!,
    client_secret: getEnv("GOOGLE_OAUTH_CLIENT_SECRET")!,
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const refreshPayload = (await readJson(response)) as OAuthTokenPayload | null;

  if (!response.ok || !refreshPayload?.access_token) {
    const message = await apiErrorMessage("Google token refresh", response, refreshPayload);
    throw new Error(message);
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
      lastHealthCheckAt: new Date(),
      status: "ACTIVE",
    },
  });

  return refreshPayload.access_token;
}

function assertGoogleScopes(payload: StoredCredentialPayload) {
  const scope = payload.token?.scope;
  if (typeof scope !== "string") {
    return;
  }

  const scopes = scope.split(" ").map((entry) => entry.trim());
  const hasDriveWrite = scopes.includes("https://www.googleapis.com/auth/drive");
  const hasDocsWrite = scopes.includes("https://www.googleapis.com/auth/documents");
  const hasSheetsWrite = scopes.includes(
    "https://www.googleapis.com/auth/spreadsheets",
  );
  const hasSlidesWrite = scopes.includes(
    "https://www.googleapis.com/auth/presentations",
  );

  if (!hasDriveWrite || !hasDocsWrite || !hasSheetsWrite || !hasSlidesWrite) {
    throw new Error(GOOGLE_SCOPE_WARNING);
  }
}

function readRunArtifactsFromOutput(output: unknown): ReadArtifactResult {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return {
      mode: undefined,
      requestedTools: [],
      connectedTools: [],
      missingTools: [],
      blockers: [],
      text: null,
      connectorResults: [],
    } satisfies ReadArtifactResult;
  }

  const record = output as Record<string, unknown>;
  return {
    mode: typeof record.mode === "string" ? record.mode : undefined,
    requestedTools: hasArrayOfStrings(record.requestedTools)
      ? record.requestedTools
      : [],
    connectedTools: hasArrayOfStrings(record.connectedTools)
      ? record.connectedTools
      : [],
    missingTools: hasArrayOfStrings(record.missingTools)
      ? record.missingTools
      : [],
    blockers: hasArrayOfStrings(record.blockers) ? record.blockers : [],
    text: typeof record.text === "string" ? record.text : null,
    connectorResults: Array.isArray(record.connectorResults)
      ? record.connectorResults.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
        )
      : [],
  };
}

function blocksFromRunArtifacts(input: NotionMemoryInput) {
  const artifacts = readRunArtifactsFromOutput(input.runOutput);
  const blocks: NotionBlock[] = [];
  const title = input.memoryTitle
    ? `${input.memoryTitle}`
    : `Summon Memory • ${input.agentName ?? "Agent Run"} ${new Date().toISOString()}`;

  blocks.push(heading1Block(title));
  blocks.push(paragraphBlock(`Run ID: ${input.runId}`));
  if (input.agentName) {
    blocks.push(paragraphBlock(`Agent: ${input.agentName}`));
  }

  if (input.runSummary) {
    blocks.push(heading2Block("Run summary"));
    blocks.push(paragraphBlock(input.runSummary));
  }

  if (artifacts.text) {
    blocks.push(heading2Block("Run output"));
    for (const chunk of chunkText(artifacts.text)) {
      blocks.push(paragraphBlock(chunk));
    }
  }

  if (artifacts.mode) {
    blocks.push(heading2Block("Execution mode"));
    blocks.push(paragraphBlock(artifacts.mode));
  }

  if (artifacts.requestedTools.length > 0) {
    blocks.push(heading2Block("Requested tools"));
    blocks.push(...bulletItems(artifacts.requestedTools));
  }

  if (artifacts.connectedTools.length > 0) {
    blocks.push(heading2Block("Connected tools"));
    blocks.push(...bulletItems(artifacts.connectedTools));
  }

  if (artifacts.missingTools.length > 0) {
    blocks.push(heading2Block("Missing tools"));
    blocks.push(...bulletItems(artifacts.missingTools));
  }

  if (artifacts.blockers.length > 0) {
    blocks.push(heading2Block("Blockers"));
    blocks.push(...bulletItems(artifacts.blockers));
  }

  if (artifacts.connectorResults.length > 0) {
    blocks.push(heading2Block("Connector artifacts"));
    artifacts.connectorResults.slice(0, 8).forEach((record) => {
      const source =
        typeof record.source === "string" ? record.source : "connector";
      const title = typeof record.title === "string" ? record.title : "Untitled artifact";
      const url = typeof record.url === "string" ? record.url : undefined;
      const query = typeof record.query === "string" ? record.query : undefined;
      const snippet = typeof record.snippet === "string" ? record.snippet : null;
      const summary = [title, query ? `query: ${query}` : null]
        .filter(Boolean)
        .join(" — ");
      blocks.push(paragraphBlock(`${source}: ${summary}`, url));
      if (snippet) {
        for (const chunk of chunkText(snippet, 1200)) {
          blocks.push(paragraphBlock(chunk));
        }
      }
    });
  }

  return blocks;
}

async function resolveGoogleDriveCredential(workspaceId: string, connectorType = "google-drive") {
  const credential = await getWorkspaceConnectorCredential(workspaceId, connectorType);
  if (!credential) {
    throw new Error(
      "Google Drive is not connected for this workspace. Reconnect Google Drive with write-capable scopes.",
    );
  }

  return credential;
}

async function resolveNotionCredential(workspaceId: string) {
  const credential = await getWorkspaceConnectorCredential(workspaceId, "notion");
  if (!credential) {
    throw new Error(
      "Notion is not connected for this workspace. Connect Notion before writing memory pages.",
  );
  }

  return credential;
}

export async function importPptxAsGoogleSlides(
  input: GoogleSlidesImportInput,
): Promise<GoogleSlidesImportResult> {
  const credential = await resolveGoogleDriveCredential(
    input.workspaceId,
    input.connectorType ?? "google-drive",
  );
  const payload = getCredentialPayload(credential);
  assertGoogleScopes(payload);
  const accessToken = await refreshGoogleAccessToken(credential);
  const fileData = normalizeBinaryData(input.pptx);
  const slideName = input.slideName?.trim() || input.fileName.trim();
  const sanitizedFileName = input.fileName.trim() || "imported-presentation.pptx";
  const metadata = {
    name: slideName,
    mimeType: GOOGLE_SLIDES_MIME,
    ...(input.folderId ? { parents: [input.folderId] } : {}),
  };
  const { boundary, body } = toMultipartBody([
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json; charset=UTF-8",
      ].join("\r\n"),
      body: JSON.stringify(metadata),
    },
    {
      headers: [
        `Content-Disposition: form-data; name="file"; filename="${sanitizedFileName.replace(/"/g, "")}"`,
        `Content-Type: ${GOOGLE_PPTX_MIME}`,
      ].join("\r\n"),
      body: fileData,
    },
  ]);

  const createResponse = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const createPayload = (await readJson(createResponse)) as
    | {
        id?: string;
        name?: string;
        mimeType?: string;
        webViewLink?: string;
        webContentLink?: string;
        error?: { message?: string };
      }
    | null;

  if (!createResponse.ok || typeof createPayload?.id !== "string") {
    const message = await apiErrorMessage("Google Drive upload", createResponse, createPayload);
    throw new Error(message);
  }

  const fileId = createPayload.id;
  const metadataResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId,
    )}?fields=id,name,mimeType,webViewLink,webContentLink`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  const metadataPayload = (await readJson(metadataResponse)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string; webContentLink?: string; }
    | null;
  if (!metadataResponse.ok || !metadataPayload?.id) {
    const message = await apiErrorMessage(
      "Google Drive file metadata",
      metadataResponse,
      metadataPayload,
    );
    throw new Error(message);
  }

  return {
    fileId: metadataPayload.id,
    fileName: metadataPayload.name ?? createPayload.name ?? sanitizedFileName,
    mimeType: metadataPayload.mimeType ?? createPayload.mimeType ?? GOOGLE_SLIDES_MIME,
    webViewLink: metadataPayload.webViewLink ?? null,
    webContentLink: metadataPayload.webContentLink ?? null,
  };
}

async function googleCredentialAndToken(workspaceId: string) {
  const credential = await resolveGoogleDriveCredential(workspaceId);
  const payload = getCredentialPayload(credential);
  assertGoogleScopes(payload);
  return {
    credential,
    accessToken: await refreshGoogleAccessToken(credential),
  };
}

type GoogleWorkspaceCapabilityStatus = "READY" | "DEGRADED" | "ERROR";

type GoogleWorkspaceCapability = {
  key: "drive" | "docs" | "sheets" | "slides";
  name: string;
  status: GoogleWorkspaceCapabilityStatus;
  message: string;
  action?: string;
  actionHref?: string;
};

function googleCloudProjectParam() {
  const clientId = getEnv("GOOGLE_OAUTH_CLIENT_ID");
  const projectNumber = clientId?.match(/^(\d+)-/)?.[1];
  return projectNumber ? `?project=${encodeURIComponent(projectNumber)}` : "";
}

function googleCloudApiHref(apiId: string) {
  return `https://console.cloud.google.com/apis/library/${apiId}${googleCloudProjectParam()}`;
}

async function probeGoogleApi(input: {
  accessToken: string;
  key: GoogleWorkspaceCapability["key"];
  name: string;
  url: string;
  readyMessage: string;
  disabledAction: string;
  disabledActionHref?: string;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(input.url, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    const payload = await readJson(response);

    if (response.ok || response.status === 400 || response.status === 404) {
      return {
        key: input.key,
        name: input.name,
        status: "READY",
        message: input.readyMessage,
      } satisfies GoogleWorkspaceCapability;
    }

    const message = await apiErrorMessage(input.name, response, payload);
    if (isGoogleApiDisabledError(new Error(message))) {
      return {
        key: input.key,
        name: input.name,
        status: "DEGRADED",
        message,
        action: input.disabledAction,
        actionHref: input.disabledActionHref,
      } satisfies GoogleWorkspaceCapability;
    }

    return {
      key: input.key,
      name: input.name,
      status: "ERROR",
      message,
      action: "Reconnect Google Drive or check the Google Cloud OAuth/API configuration.",
    } satisfies GoogleWorkspaceCapability;
  } catch (error) {
    const causeCode =
      error instanceof Error &&
      "cause" in error &&
      error.cause &&
      typeof error.cause === "object" &&
      "code" in error.cause &&
      typeof error.cause.code === "string"
        ? error.cause.code
        : null;
    const isTimeout =
      (error instanceof Error && error.name === "AbortError") ||
      causeCode === "UND_ERR_CONNECT_TIMEOUT";
    const cause =
      causeCode ? ` (${causeCode})` : "";
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `${input.name} capability probe timed out after 15 seconds.`
        : error instanceof Error
          ? `${error.message}${cause}`
          : String(error);

    return {
      key: input.key,
      name: input.name,
      status: isTimeout ? "DEGRADED" : "ERROR",
      message,
      action:
        isTimeout
          ? "Retry the health check. If this stays degraded, verify network access and confirm the API is enabled in Google Cloud."
          : "Reconnect Google Drive or check the Google Cloud OAuth/API configuration.",
      actionHref: input.disabledActionHref,
    } satisfies GoogleWorkspaceCapability;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getGoogleWorkspaceDiagnostics(workspaceId: string) {
  try {
    const { accessToken } = await googleCredentialAndToken(workspaceId);
    const fakeId = "summon-diagnostic-probe-does-not-exist";
    const probes = [
      {
        accessToken,
        key: "drive" as const,
        name: "Google Drive API",
        url: "https://www.googleapis.com/drive/v3/about?fields=user",
        readyMessage: "Drive API is reachable for file search, copy, upload, and metadata.",
        disabledAction:
          "Enable the Google Drive API in the Google Cloud project used by this OAuth client.",
        disabledActionHref: googleCloudApiHref("drive.googleapis.com"),
      },
      {
        accessToken,
        key: "docs" as const,
        name: "Google Docs API",
        url: `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fakeId)}?fields=documentId`,
        readyMessage:
          "Docs API is reachable. The test document was intentionally fake, so this proves API availability without mutating files.",
        disabledAction:
          "Enable the Google Docs API in the Google Cloud project used by this OAuth client.",
        disabledActionHref: googleCloudApiHref("docs.googleapis.com"),
      },
      {
        accessToken,
        key: "sheets" as const,
        name: "Google Sheets API",
        url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fakeId)}?fields=spreadsheetId`,
        readyMessage:
          "Sheets API is reachable. Native ranges, formulas, formatting, and chart operations can be used when tools support them.",
        disabledAction:
          "Enable the Google Sheets API in the Google Cloud project used by this OAuth client. Until then, agents use Drive CSV fallback for simple run-owned sheets.",
        disabledActionHref: googleCloudApiHref("sheets.googleapis.com"),
      },
      {
        accessToken,
        key: "slides" as const,
        name: "Google Slides API",
        url: `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(fakeId)}?fields=presentationId`,
        readyMessage:
          "Slides API is reachable. The test presentation was intentionally fake, so this proves API availability without mutating files.",
        disabledAction:
          "Enable the Google Slides API in the Google Cloud project used by this OAuth client.",
        disabledActionHref: googleCloudApiHref("slides.googleapis.com"),
      },
    ];
    const capabilities = await Promise.all(
      probes.map((probe) => probeGoogleApi(probe)),
    );

    const status: GoogleWorkspaceCapabilityStatus = capabilities.some(
      (capability) => capability.status === "ERROR",
    )
      ? "ERROR"
      : capabilities.some((capability) => capability.status === "DEGRADED")
        ? "DEGRADED"
        : "READY";

    return {
      status,
      checkedAt: new Date().toISOString(),
      capabilities,
    };
  } catch (error) {
    return {
      status: "ERROR" as const,
      checkedAt: new Date().toISOString(),
      capabilities: [
        {
          key: "drive" as const,
          name: "Google Workspace credential",
          status: "ERROR" as const,
          message: error instanceof Error ? error.message : String(error),
          action:
            "Reconnect Google Drive with write-capable scopes and confirm OAuth environment values.",
        },
      ],
    };
  }
}

function googleFileFields() {
  return "id,name,mimeType,webViewLink,webContentLink";
}

export async function createGoogleDriveBinaryFile(
  input: GoogleDriveBinaryUploadInput,
): Promise<
  GoogleDriveFileResult & {
    webContentLink: string | null;
    downloadUrl: string;
    publicPermissionCreated: boolean;
  }
> {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  const fileData = normalizeBinaryData(input.content);
  const fileName = input.name.trim() || "generated-artifact";
  const metadata = {
    name: fileName,
    mimeType: input.mimeType,
    ...(input.parentFolderId ? { parents: [input.parentFolderId] } : {}),
  };
  const { boundary, body } = toMultipartBody([
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json; charset=UTF-8",
      ].join("\r\n"),
      body: JSON.stringify(metadata),
    },
    {
      headers: [
        `Content-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, "")}"`,
        `Content-Type: ${input.mimeType}`,
      ].join("\r\n"),
      body: fileData,
    },
  ]);

  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(
      googleFileFields(),
    )}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const payload = (await readJson(response)) as
    | {
        id?: string;
        name?: string;
        mimeType?: string;
        webViewLink?: string;
        webContentLink?: string;
      }
    | null;

  if (!response.ok || !payload?.id) {
    const message = await apiErrorMessage("Google Drive artifact upload", response, payload);
    throw new Error(message);
  }

  let publicPermissionCreated = false;
  if (input.makePublic ?? true) {
    const permissionResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        payload.id,
      )}/permissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role: "reader",
          type: "anyone",
        }),
      },
    );
    const permissionPayload = await readJson(permissionResponse);
    if (!permissionResponse.ok) {
      const message = await apiErrorMessage(
        "Google Drive artifact permission",
        permissionResponse,
        permissionPayload,
      );
      throw new Error(message);
    }
    publicPermissionCreated = true;
  }

  return {
    fileId: payload.id,
    fileName: payload.name ?? fileName,
    mimeType: payload.mimeType ?? input.mimeType,
    webViewLink: payload.webViewLink ?? null,
    webContentLink: payload.webContentLink ?? null,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
      payload.id,
    )}`,
    publicPermissionCreated,
  };
}

async function getGoogleDriveMetadata(input: {
  accessToken: string;
  fileId: string;
  provider?: string;
}) {
  const metadataResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      input.fileId,
    )}?fields=${encodeURIComponent(googleFileFields())}`,
    {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
  );
  const metadataPayload = (await readJson(metadataResponse)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string }
    | null;

  if (!metadataResponse.ok || !metadataPayload?.id) {
    const message = await apiErrorMessage(
      input.provider ?? "Google Drive file metadata",
      metadataResponse,
      metadataPayload,
    );
    throw new Error(message);
  }

  return {
    fileId: metadataPayload.id,
    fileName: metadataPayload.name ?? "Google file",
    mimeType: metadataPayload.mimeType ?? null,
    webViewLink: metadataPayload.webViewLink ?? null,
  } satisfies GoogleDriveFileResult;
}

async function createGoogleDocViaDriveUpload(input: {
  accessToken: string;
  title: string;
  text?: string;
}) {
  const metadata = {
    name: input.title,
    mimeType: GOOGLE_DOCS_MIME,
  };
  const html = textToGoogleDocHtml({ text: input.text ?? "" });
  const { boundary, body } = toMultipartBody([
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json; charset=UTF-8",
      ].join("\r\n"),
      body: JSON.stringify(metadata),
    },
    {
      headers: [
        `Content-Disposition: form-data; name="file"; filename="${input.title.replace(/"/g, "")}.html"`,
        "Content-Type: text/html; charset=UTF-8",
      ].join("\r\n"),
      body: html,
    },
  ]);

  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(
      googleFileFields(),
    )}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const payload = (await readJson(response)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string }
    | null;

  if (!response.ok || !payload?.id) {
    const message = await apiErrorMessage("Google Drive Doc upload", response, payload);
    throw new Error(message);
  }

  return {
    documentId: payload.id,
    fileId: payload.id,
    fileName: payload.name ?? input.title,
    mimeType: payload.mimeType ?? GOOGLE_DOCS_MIME,
    webViewLink: payload.webViewLink ?? null,
    mode: "drive_upload_conversion_fallback",
  } satisfies GoogleDriveFileResult & { documentId: string };
}

async function exportGoogleDocTextViaDrive(input: {
  accessToken: string;
  documentId: string;
}) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      input.documentId,
    )}/export?mimeType=${encodeURIComponent("text/plain")}`,
    {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
  );

  if (!response.ok) {
    const payload = await readJson(response);
    const message = await apiErrorMessage("Google Drive Doc export", response, payload);
    throw new Error(message);
  }

  return response.text();
}

async function updateGoogleDocViaDriveUpload(input: {
  accessToken: string;
  documentId: string;
  text: string;
}) {
  const html = textToGoogleDocHtml({ text: input.text });
  const { boundary, body } = toMultipartBody([
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json; charset=UTF-8",
      ].join("\r\n"),
      body: JSON.stringify({ mimeType: GOOGLE_DOCS_MIME }),
    },
    {
      headers: [
        'Content-Disposition: form-data; name="file"; filename="document.html"',
        "Content-Type: text/html; charset=UTF-8",
      ].join("\r\n"),
      body: html,
    },
  ]);

  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(
      input.documentId,
    )}?uploadType=multipart&fields=${encodeURIComponent(googleFileFields())}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const payload = (await readJson(response)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string }
    | null;

  if (!response.ok || !payload?.id) {
    const message = await apiErrorMessage(
      "Google Drive Doc update upload",
      response,
      payload,
    );
    throw new Error(message);
  }

  return {
    documentId: payload.id,
    fileId: payload.id,
    fileName: payload.name ?? "Google Doc",
    mimeType: payload.mimeType ?? GOOGLE_DOCS_MIME,
    webViewLink: payload.webViewLink ?? null,
    mode: "drive_upload_conversion_fallback",
  };
}

export async function copyGoogleDriveFile(input: {
  workspaceId: string;
  fileId: string;
  name?: string;
  parentFolderId?: string | null;
}): Promise<GoogleDriveFileResult> {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      input.fileId,
    )}/copy?fields=${encodeURIComponent(googleFileFields())}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(input.name ? { name: input.name } : {}),
        ...(input.parentFolderId ? { parents: [input.parentFolderId] } : {}),
      }),
    },
  );
  const payload = (await readJson(response)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string }
    | null;

  if (!response.ok || !payload?.id) {
    const message = await apiErrorMessage("Google Drive copy", response, payload);
    throw new Error(message);
  }

  return {
    fileId: payload.id,
    fileName: payload.name ?? input.name ?? "Copied file",
    mimeType: payload.mimeType ?? null,
    webViewLink: payload.webViewLink ?? null,
  };
}

export async function readGoogleSlidesText(input: {
  workspaceId: string;
  presentationId: string;
}) {
  const inspected = await inspectGoogleSlidesTemplate(input);
  return {
    presentationId: inspected.presentationId,
    title: inspected.title,
    slides: inspected.slides.map((slide) => ({
      slideIndex: slide.slideIndex,
      slideObjectId: slide.slideObjectId,
      textElements: slide.textElements,
    })),
  };
}

function readSlidesTextRuns(
  text:
    | {
        textElements?: Array<{
          textRun?: {
            content?: string;
          };
        }>;
      }
    | undefined,
) {
  return (text?.textElements ?? [])
    .map((textElement) => textElement.textRun?.content ?? "")
    .join("")
    .trim();
}

function classifySlide(input: {
  text: string;
  hasTable: boolean;
  hasImage: boolean;
  hasChart: boolean;
}) {
  const text = input.text.toLowerCase();
  if (text.length < 90 && !input.hasTable && !input.hasImage && !input.hasChart) {
    return "section_divider";
  }
  if (input.hasTable) {
    return "table_slide";
  }
  if (input.hasChart || input.hasImage || /\b(chart|trend|performance)\b/.test(text)) {
    return "chart_slide";
  }
  if (/\b(summary|overview|recommendation|commentary|insight)\b/.test(text)) {
    return "commentary_slide";
  }
  if (/\b(leads|spend|cpl|ctr|cvr|clicks|revenue|cost)\b/.test(text)) {
    return "kpi_summary";
  }
  return "placeholder_candidate";
}

export async function inspectGoogleSlidesTemplate(input: {
  workspaceId: string;
  presentationId: string;
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  const response = await fetch(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(
      input.presentationId,
    )}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    const message = await apiErrorMessage("Google Slides read", response, payload);
    throw new Error(message);
  }

  const presentation = payload as {
    presentationId?: string;
    title?: string;
    slides?: Array<{
      objectId?: string;
      pageElements?: Array<{
        objectId?: string;
        size?: unknown;
        transform?: unknown;
        shape?: {
          shapeType?: string;
          text?: {
            textElements?: Array<{
              textRun?: {
                content?: string;
              };
            }>;
          };
        };
        image?: {
          contentUrl?: string;
        };
        sheetsChart?: {
          spreadsheetId?: string;
          chartId?: number;
        };
        table?: {
          tableRows?: Array<{
            tableCells?: Array<{
              text?: {
                textElements?: Array<{
                  textRun?: {
                    content?: string;
                  };
                }>;
              };
            }>;
          }>;
        };
      }>;
    }>;
  };

  return {
    presentationId: presentation.presentationId ?? input.presentationId,
    title: presentation.title ?? null,
    slides: (presentation.slides ?? []).map((slide, slideIndex) => {
      const pageElements = slide.pageElements ?? [];
      const textElements = pageElements
        .flatMap((element): GoogleSlidesTextElement[] => {
          const shapeText = readSlidesTextRuns(element.shape?.text);

          const shapeElements: GoogleSlidesTextElement[] = shapeText
            ? [
                {
                  objectId: element.objectId ?? null,
                  text: shapeText,
                  source: "shape",
                  size: element.size ?? null,
                  transform: element.transform ?? null,
                },
              ]
            : [];

          const tableElements = (element.table?.tableRows ?? []).flatMap(
            (row, rowIndex) =>
              (row.tableCells ?? []).map((cell, columnIndex) => ({
                objectId: element.objectId ?? null,
                text: readSlidesTextRuns(cell.text),
                source: "table_cell" as const,
                rowIndex,
                columnIndex,
              })),
          );

          return [...shapeElements, ...tableElements];
        })
        .filter((element) => element.text);

      const combinedText = textElements.map((element) => element.text).join("\n");
      const hasTable = pageElements.some((element) => Boolean(element.table));
      const hasImage = pageElements.some((element) => Boolean(element.image));
      const hasChart = pageElements.some((element) => Boolean(element.sheetsChart));

      return {
        slideIndex: slideIndex + 1,
        slideObjectId: slide.objectId ?? null,
        classification: classifySlide({
          text: combinedText,
          hasTable,
          hasImage,
          hasChart,
        }),
        titleCandidate: textElements.find((element) => element.source === "shape")?.text ?? null,
        textElements,
        pageElements: pageElements.map((element) => ({
          objectId: element.objectId ?? null,
          type: element.table
            ? "table"
            : element.sheetsChart
              ? "sheets_chart"
              : element.image
                ? "image"
                : element.shape
                  ? "shape"
                  : "unknown",
          size: element.size ?? null,
          transform: element.transform ?? null,
          shapeType: element.shape?.shapeType ?? null,
          text: readSlidesTextRuns(element.shape?.text) || null,
          table: element.table
            ? {
                rowCount: element.table.tableRows?.length ?? 0,
                columnCount:
                  element.table.tableRows?.[0]?.tableCells?.length ?? 0,
                cells: (element.table.tableRows ?? []).flatMap((row, rowIndex) =>
                  (row.tableCells ?? []).map((cell, columnIndex) => ({
                    rowIndex,
                    columnIndex,
                    text: readSlidesTextRuns(cell.text),
                  })),
                ),
              }
            : null,
          image: element.image
            ? {
                hasContentUrl: Boolean(element.image.contentUrl),
              }
            : null,
          sheetsChart: element.sheetsChart ?? null,
        })),
      };
    }),
  };
}

export async function createGoogleDriveTextFile(input: {
  workspaceId: string;
  name: string;
  content: string;
  mimeType?: string;
  parentFolderId?: string | null;
}): Promise<GoogleDriveFileResult> {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  const metadata = {
    name: input.name,
    ...(input.parentFolderId ? { parents: [input.parentFolderId] } : {}),
  };
  const { boundary, body } = toMultipartBody([
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json; charset=UTF-8",
      ].join("\r\n"),
      body: JSON.stringify(metadata),
    },
    {
      headers: [
        `Content-Disposition: form-data; name="file"; filename="${input.name.replace(/"/g, "")}"`,
        `Content-Type: ${input.mimeType ?? "text/plain"}`,
      ].join("\r\n"),
      body: input.content,
    },
  ]);
  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(
      googleFileFields(),
    )}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const payload = (await readJson(response)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string }
    | null;

  if (!response.ok || !payload?.id) {
    const message = await apiErrorMessage("Google Drive upload", response, payload);
    throw new Error(message);
  }

  return {
    fileId: payload.id,
    fileName: payload.name ?? input.name,
    mimeType: payload.mimeType ?? input.mimeType ?? "text/plain",
    webViewLink: payload.webViewLink ?? null,
  };
}

function readGoogleDocTextElements(value: unknown): string {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const textRun = record.textRun && typeof record.textRun === "object"
    ? (record.textRun as Record<string, unknown>)
    : {};
  return typeof textRun.content === "string" ? textRun.content : "";
}

function readGoogleDocStructuralText(elements: unknown[]): string {
  return elements
    .map((element) => {
      const record =
        element && typeof element === "object" && !Array.isArray(element)
          ? (element as Record<string, unknown>)
          : {};
      const paragraph =
        record.paragraph && typeof record.paragraph === "object"
          ? (record.paragraph as Record<string, unknown>)
          : null;
      if (paragraph && Array.isArray(paragraph.elements)) {
        return paragraph.elements.map(readGoogleDocTextElements).join("");
      }

      const table =
        record.table && typeof record.table === "object"
          ? (record.table as Record<string, unknown>)
          : null;
      if (table && Array.isArray(table.tableRows)) {
        return table.tableRows
          .map((row) => {
            const rowRecord =
              row && typeof row === "object" && !Array.isArray(row)
                ? (row as Record<string, unknown>)
                : {};
            return Array.isArray(rowRecord.tableCells)
              ? rowRecord.tableCells
                  .map((cell) => {
                    const cellRecord =
                      cell && typeof cell === "object" && !Array.isArray(cell)
                        ? (cell as Record<string, unknown>)
                        : {};
                    return Array.isArray(cellRecord.content)
                      ? readGoogleDocStructuralText(cellRecord.content)
                      : "";
                  })
                  .join("\t")
              : "";
          })
          .join("\n");
      }

      return "";
    })
    .join("")
    .trim();
}

function applyGoogleDocTextFallbackRequests(input: {
  text: string;
  requests: Record<string, unknown>[];
}) {
  let text = input.text;
  const replies: Array<Record<string, unknown>> = [];

  for (const request of input.requests) {
    const replaceAllText =
      request.replaceAllText &&
      typeof request.replaceAllText === "object" &&
      !Array.isArray(request.replaceAllText)
        ? (request.replaceAllText as Record<string, unknown>)
        : null;
    if (replaceAllText) {
      const containsText =
        replaceAllText.containsText &&
        typeof replaceAllText.containsText === "object" &&
        !Array.isArray(replaceAllText.containsText)
          ? (replaceAllText.containsText as Record<string, unknown>)
          : {};
      const find = typeof containsText.text === "string" ? containsText.text : "";
      const replaceText =
        typeof replaceAllText.replaceText === "string"
          ? replaceAllText.replaceText
          : "";
      if (!find) {
        replies.push({ replaceAllText: { occurrencesChanged: 0 } });
        continue;
      }
      const matchCase = containsText.matchCase !== false;
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, matchCase ? "g" : "gi");
      const matches = text.match(regex);
      const occurrencesChanged = matches?.length ?? 0;
      text = text.replace(regex, replaceText);
      replies.push({ replaceAllText: { occurrencesChanged } });
      continue;
    }

    const insertText =
      request.insertText &&
      typeof request.insertText === "object" &&
      !Array.isArray(request.insertText)
        ? (request.insertText as Record<string, unknown>)
        : null;
    if (insertText) {
      const insert = typeof insertText.text === "string" ? insertText.text : "";
      const location =
        insertText.location &&
        typeof insertText.location === "object" &&
        !Array.isArray(insertText.location)
          ? (insertText.location as Record<string, unknown>)
          : {};
      const rawIndex =
        typeof location.index === "number" && Number.isFinite(location.index)
          ? location.index
          : text.length + 1;
      const index = Math.max(0, Math.min(text.length, rawIndex - 1));
      text = `${text.slice(0, index)}${insert}${text.slice(index)}`;
      replies.push({ insertText: {} });
      continue;
    }

    replies.push({
      unsupportedFallbackRequest: {
        message:
          "Drive conversion fallback only supports insertText and replaceAllText. Enable Google Docs API for full Docs batchUpdate support.",
      },
    });
  }

  return { text, replies };
}

type MarkdownStyleRange = {
  startIndex: number;
  endIndex: number;
  type: "heading1" | "heading2" | "heading3" | "bullet" | "numbered" | "bold";
};

function cleanInlineMarkdown(line: string) {
  let output = "";
  const boldRanges: Array<{ start: number; end: number }> = [];
  let index = 0;

  while (index < line.length) {
    const boldStart = line.indexOf("**", index);
    const linkStart = line.indexOf("[", index);
    const nextSpecial = [boldStart, linkStart]
      .filter((value) => value >= 0)
      .sort((a, b) => a - b)[0];

    if (nextSpecial === undefined) {
      output += line.slice(index);
      break;
    }

    output += line.slice(index, nextSpecial);

    if (nextSpecial === boldStart) {
      const boldEnd = line.indexOf("**", boldStart + 2);
      if (boldEnd < 0) {
        output += line.slice(boldStart);
        break;
      }
      const start = output.length;
      output += line.slice(boldStart + 2, boldEnd);
      const end = output.length;
      if (end > start) {
        boldRanges.push({ start, end });
      }
      index = boldEnd + 2;
      continue;
    }

    const labelEnd = line.indexOf("]", linkStart + 1);
    const urlStart = labelEnd >= 0 ? line.indexOf("(", labelEnd + 1) : -1;
    const urlEnd = urlStart >= 0 ? line.indexOf(")", urlStart + 1) : -1;
    if (labelEnd >= 0 && urlStart === labelEnd + 1 && urlEnd > urlStart) {
      const label = line.slice(linkStart + 1, labelEnd);
      const url = line.slice(urlStart + 1, urlEnd);
      output += url ? `${label} (${url})` : label;
      index = urlEnd + 1;
      continue;
    }

    output += line[nextSpecial];
    index = nextSpecial + 1;
  }

  return {
    text: output.replace(/`([^`]+)`/g, "$1").replace(/_{2}([^_]+)_{2}/g, "$1"),
    boldRanges,
  };
}

function markdownToGoogleDocRequests(markdown: string) {
  const textParts: string[] = [];
  const styles: MarkdownStyleRange[] = [];

  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const paragraphStartIndex = 1 + textParts.join("").length;
    const trimmed = rawLine.trim();
    let type: MarkdownStyleRange["type"] | null = null;
    let line = rawLine;

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      type =
        heading[1].length === 1
          ? "heading1"
          : heading[1].length === 2
            ? "heading2"
            : "heading3";
      line = heading[2];
    } else if (/^[-*]\s+/.test(trimmed)) {
      type = "bullet";
      line = trimmed.replace(/^[-*]\s+/, "");
    } else if (/^\d+[.)]\s+/.test(trimmed)) {
      type = "numbered";
      line = trimmed.replace(/^\d+[.)]\s+/, "");
    }

    const { text, boldRanges } = cleanInlineMarkdown(line);
    textParts.push(`${text}\n`);
    const paragraphEndIndex = paragraphStartIndex + text.length + 1;

    if (type && text.trim()) {
      styles.push({
        startIndex: paragraphStartIndex,
        endIndex: paragraphEndIndex,
        type,
      });
    }

    for (const range of boldRanges) {
      styles.push({
        startIndex: paragraphStartIndex + range.start,
        endIndex: paragraphStartIndex + range.end,
        type: "bold",
      });
    }
  }

  const text = textParts.join("").trimEnd();
  const requests: Record<string, unknown>[] = [
    {
      insertText: {
        location: { index: 1 },
        text,
      },
    },
  ];

  for (const style of styles) {
    if (style.endIndex <= style.startIndex) {
      continue;
    }

    if (style.type === "bold") {
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: style.startIndex,
            endIndex: style.endIndex,
          },
          textStyle: { bold: true },
          fields: "bold",
        },
      });
      continue;
    }

    if (style.type === "bullet" || style.type === "numbered") {
      requests.push({
        createParagraphBullets: {
          range: {
            startIndex: style.startIndex,
            endIndex: style.endIndex,
          },
          bulletPreset:
            style.type === "numbered"
              ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
              : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
      continue;
    }

    requests.push({
      updateParagraphStyle: {
        range: {
          startIndex: style.startIndex,
          endIndex: style.endIndex,
        },
        paragraphStyle: {
          namedStyleType:
            style.type === "heading1"
              ? "HEADING_1"
              : style.type === "heading2"
                ? "HEADING_2"
                : "HEADING_3",
        },
        fields: "namedStyleType",
      },
    });
  }

  return requests;
}

export async function writeMarkdownToGoogleDoc(input: {
  workspaceId: string;
  documentId: string;
  markdown: string;
}) {
  const markdown = input.markdown.trim();
  if (!markdown) {
    return {
      documentId: input.documentId,
      requestCount: 0,
      skipped: true,
    };
  }

  return batchUpdateGoogleDoc({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    requests: markdownToGoogleDocRequests(markdown),
  });
}

export async function createGoogleDoc(input: {
  workspaceId: string;
  title: string;
}): Promise<GoogleDriveFileResult & { documentId: string }> {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  let payload: { documentId?: string; title?: string } | null = null;
  try {
    const response = await fetch("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: input.title }),
    });
    payload = (await readJson(response)) as
      | { documentId?: string; title?: string }
      | null;

    if (!response.ok || !payload?.documentId) {
      const message = await apiErrorMessage("Google Docs create", response, payload);
      throw new Error(message);
    }
  } catch (error) {
    if (isGoogleApiDisabledError(error)) {
      return createGoogleDocViaDriveUpload({
        accessToken,
        title: input.title,
      });
    }
    throw error;
  }

  const metadataPayload = await getGoogleDriveMetadata({
    accessToken,
    fileId: payload.documentId,
    provider: "Google Docs metadata",
  });
  return {
    documentId: payload.documentId,
    ...metadataPayload,
    fileName: metadataPayload.fileName ?? payload.title ?? input.title,
    mimeType: metadataPayload.mimeType ?? GOOGLE_DOCS_MIME,
  };
}

export async function readGoogleDocText(input: {
  workspaceId: string;
  documentId: string;
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  let payload:
    | {
        documentId?: string;
        title?: string;
        body?: { content?: unknown[] };
      }
    | null = null;
  try {
    const response = await fetch(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(input.documentId)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    payload = (await readJson(response)) as
      | {
          documentId?: string;
          title?: string;
          body?: { content?: unknown[] };
        }
      | null;

    if (!response.ok || !payload?.documentId) {
      const message = await apiErrorMessage("Google Docs read", response, payload);
      throw new Error(message);
    }
  } catch (error) {
    if (isGoogleApiDisabledError(error)) {
      const [text, metadata] = await Promise.all([
        exportGoogleDocTextViaDrive({
          accessToken,
          documentId: input.documentId,
        }),
        getGoogleDriveMetadata({
          accessToken,
          fileId: input.documentId,
          provider: "Google Docs fallback metadata",
        }),
      ]);
      return {
        documentId: input.documentId,
        title: metadata.fileName,
        text,
        preview: text.slice(0, 8000),
        mode: "drive_export_fallback",
      };
    }
    throw error;
  }

  const content = Array.isArray(payload.body?.content)
    ? payload.body.content
    : [];
  const text = readGoogleDocStructuralText(content);

  return {
    documentId: payload.documentId,
    title: payload.title ?? "Untitled document",
    text,
    preview: text.slice(0, 8000),
  };
}

export async function batchUpdateGoogleDoc(input: {
  workspaceId: string;
  documentId: string;
  requests: Record<string, unknown>[];
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  try {
    const response = await fetch(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(
        input.documentId,
      )}:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests: input.requests }),
      },
    );
    const payload = await readJson(response);

    if (!response.ok) {
      const message = await apiErrorMessage("Google Docs batchUpdate", response, payload);
      throw new Error(message);
    }

    return {
      documentId: input.documentId,
      replies: (payload as { replies?: unknown[] } | null)?.replies ?? [],
      requestCount: input.requests.length,
    };
  } catch (error) {
    if (!isGoogleApiDisabledError(error)) {
      throw error;
    }

    let currentText = "";
    try {
      currentText = await exportGoogleDocTextViaDrive({
        accessToken,
        documentId: input.documentId,
      });
    } catch {
      currentText = "";
    }
    const applied = applyGoogleDocTextFallbackRequests({
      text: currentText,
      requests: input.requests,
    });
    const updated = await updateGoogleDocViaDriveUpload({
      accessToken,
      documentId: input.documentId,
      text: applied.text,
    });

    return {
      documentId: input.documentId,
      replies: applied.replies,
      requestCount: input.requests.length,
      mode: "drive_upload_conversion_fallback",
      fileId: updated.fileId,
      fileName: updated.fileName,
      mimeType: updated.mimeType,
      webViewLink: updated.webViewLink,
    };
  }
}

export async function replaceGoogleDocText(input: {
  workspaceId: string;
  documentId: string;
  replacements: Array<{ find: string; replace: string }>;
}) {
  return batchUpdateGoogleDoc({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    requests: input.replacements.map((replacement) => ({
      replaceAllText: {
        containsText: {
          text: replacement.find,
          matchCase: true,
        },
        replaceText: replacement.replace,
      },
    })),
  });
}

export async function readGoogleSheetRange(input: {
  workspaceId: string;
  spreadsheetId: string;
  range: string;
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  try {
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        input.spreadsheetId,
      )}/values/${encodeURIComponent(input.range)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const payload = await readJson(response);
    if (!response.ok) {
      const message = await apiErrorMessage("Google Sheets read", response, payload);
      throw new Error(message);
    }

    return payload;
  } catch (error) {
    if (isGoogleApiDisabledError(error)) {
      const csv = await exportGoogleSheetCsvViaDrive({
        accessToken,
        spreadsheetId: input.spreadsheetId,
      });
      const values = readRowsRange(parseCsv(csv), input.range);

      return {
        range: input.range,
        majorDimension: "ROWS",
        values,
        mode: "drive_csv_export_fallback",
        note: "Google Sheets API is disabled. Returned values from Drive CSV export of the first sheet.",
      };
    }

    throw error;
  }
}

async function exportGoogleSheetCsvViaDrive(input: {
  accessToken: string;
  spreadsheetId: string;
}) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      input.spreadsheetId,
    )}/export?mimeType=${encodeURIComponent("text/csv")}`,
    {
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
  );
  const text = await response.text();

  if (!response.ok) {
    let payload: unknown = text;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // Keep raw text for the error message.
    }
    const message = await apiErrorMessage("Google Sheets Drive export", response, payload);
    throw new Error(message);
  }

  return text;
}

async function updateGoogleSheetViaDriveUpload(input: {
  accessToken: string;
  spreadsheetId: string;
  range: string;
  values: unknown[][];
}) {
  const currentCsv = await exportGoogleSheetCsvViaDrive({
    accessToken: input.accessToken,
    spreadsheetId: input.spreadsheetId,
  });
  const nextRows = writeRowsRange(parseCsv(currentCsv), input.range, input.values);
  const csv = rowsToCsv(nextRows);
  const metadata = { mimeType: GOOGLE_SHEETS_MIME };
  const { boundary, body } = toMultipartBody([
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json; charset=UTF-8",
      ].join("\r\n"),
      body: JSON.stringify(metadata),
    },
    {
      headers: [
        'Content-Disposition: form-data; name="file"; filename="updated-sheet.csv"',
        "Content-Type: text/csv; charset=UTF-8",
      ].join("\r\n"),
      body: csv,
    },
  ]);
  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(
      input.spreadsheetId,
    )}?uploadType=multipart&fields=id,name,mimeType,webViewLink`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const payload = (await readJson(response)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string }
    | null;

  if (!response.ok || !payload?.id) {
    const message = await apiErrorMessage("Google Sheets Drive update", response, payload);
    throw new Error(message);
  }

  return {
    spreadsheetId: payload.id,
    updatedRange: input.range,
    updatedRows: input.values.length,
    fileName: payload.name,
    webViewLink: payload.webViewLink ?? null,
    mimeType: payload.mimeType ?? GOOGLE_SHEETS_MIME,
    mode: "drive_csv_update_fallback",
    note: "Google Sheets API is disabled. Updated the first sheet by replacing the run-owned spreadsheet contents through Drive CSV upload.",
  };
}

async function createGoogleSheetViaDriveUpload(input: {
  accessToken: string;
  title: string;
  rows: unknown[][];
}) {
  const csv = rowsToCsv(input.rows.length > 0 ? input.rows : [[""]]);
  const metadata = {
    name: input.title,
    mimeType: GOOGLE_SHEETS_MIME,
  };
  const { boundary, body } = toMultipartBody([
    {
      headers: [
        'Content-Disposition: form-data; name="metadata"',
        "Content-Type: application/json; charset=UTF-8",
      ].join("\r\n"),
      body: JSON.stringify(metadata),
    },
    {
      headers: [
        `Content-Disposition: form-data; name="file"; filename="${input.title.replace(/"/g, "")}.csv"`,
        "Content-Type: text/csv; charset=UTF-8",
      ].join("\r\n"),
      body: csv,
    },
  ]);

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const payload = (await readJson(response)) as
    | { id?: string; name?: string; mimeType?: string; webViewLink?: string }
    | null;

  if (!response.ok || !payload?.id) {
    const message = await apiErrorMessage("Google Sheets Drive upload", response, payload);
    throw new Error(message);
  }

  return {
    spreadsheetId: payload.id,
    fileId: payload.id,
    fileName: payload.name ?? input.title,
    mimeType: payload.mimeType ?? GOOGLE_SHEETS_MIME,
    webViewLink: payload.webViewLink ?? null,
    mode: "drive_csv_conversion_fallback",
  };
}

export async function createGoogleSheet(input: {
  workspaceId: string;
  title: string;
  sheetTitle?: string;
  rows?: unknown[][];
  range?: string;
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  const title = input.title.trim() || "Generated spreadsheet";
  const sheetTitle = input.sheetTitle?.trim() || "Sheet1";
  const rows = Array.isArray(input.rows) ? input.rows : [];

  try {
    const response = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: { title },
        sheets: [{ properties: { title: sheetTitle } }],
      }),
    });
    const payload = (await readJson(response)) as
      | {
          spreadsheetId?: string;
          spreadsheetUrl?: string;
          properties?: { title?: string };
        }
      | null;

    if (!response.ok || !payload?.spreadsheetId) {
      const message = await apiErrorMessage("Google Sheets create", response, payload);
      throw new Error(message);
    }

    if (rows.length > 0) {
      await updateGoogleSheetRange({
        workspaceId: input.workspaceId,
        spreadsheetId: payload.spreadsheetId,
        range: input.range?.trim() || `${sheetTitle}!A1`,
        values: rows,
      });
    }

    const metadata = await getGoogleDriveMetadata({
      accessToken,
      fileId: payload.spreadsheetId,
      provider: "Google Sheets metadata",
    });

    return {
      spreadsheetId: payload.spreadsheetId,
      spreadsheetUrl: payload.spreadsheetUrl ?? metadata.webViewLink,
      ...metadata,
      fileName: metadata.fileName ?? payload.properties?.title ?? title,
      mimeType: metadata.mimeType ?? GOOGLE_SHEETS_MIME,
      seededRows: rows.length,
      mode: "sheets_api",
    };
  } catch (error) {
    if (isGoogleApiDisabledError(error)) {
      return createGoogleSheetViaDriveUpload({
        accessToken,
        title,
        rows,
      });
    }

    throw error;
  }
}

export async function updateGoogleSheetRange(input: {
  workspaceId: string;
  spreadsheetId: string;
  range: string;
  values: unknown[][];
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  try {
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        input.spreadsheetId,
      )}/values/${encodeURIComponent(input.range)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          range: input.range,
          majorDimension: "ROWS",
          values: input.values,
        }),
      },
    );
    const payload = await readJson(response);
    if (!response.ok) {
      const message = await apiErrorMessage("Google Sheets update", response, payload);
      throw new Error(message);
    }

    return payload;
  } catch (error) {
    if (isGoogleApiDisabledError(error)) {
      return updateGoogleSheetViaDriveUpload({
        accessToken,
        spreadsheetId: input.spreadsheetId,
        range: input.range,
        values: input.values,
      });
    }

    throw error;
  }
}

export async function batchUpdateGoogleSlides(input: {
  workspaceId: string;
  presentationId: string;
  requests: Record<string, unknown>[];
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  const endpoint = `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(
    input.presentationId,
  )}:batchUpdate`;
  const chunks: Record<string, unknown>[][] = [];
  for (let index = 0; index < input.requests.length; index += 80) {
    chunks.push(input.requests.slice(index, index + 80));
  }

  const replies: unknown[] = [];
  for (const [index, requests] of chunks.entries()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const message = await apiErrorMessage("Google Slides batchUpdate", response, payload);
        throw new Error(message);
      }

      replies.push(...asObjectArray((payload as Record<string, unknown> | null)?.replies));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Google Slides batchUpdate timed out on chunk ${index + 1}.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    presentationId: input.presentationId,
    replies,
    chunks: chunks.length,
    requestCount: input.requests.length,
  };
}

export async function updateGoogleSlidesTextElement(input: {
  workspaceId: string;
  presentationId: string;
  objectId: string;
  text: string;
}) {
  return batchUpdateGoogleSlides({
    workspaceId: input.workspaceId,
    presentationId: input.presentationId,
    requests: [
      {
        deleteText: {
          objectId: input.objectId,
          textRange: { type: "ALL" },
        },
      },
      {
        insertText: {
          objectId: input.objectId,
          insertionIndex: 0,
          text: input.text,
        },
      },
    ],
  });
}

export async function updateGoogleSlidesTableCell(input: {
  workspaceId: string;
  presentationId: string;
  tableObjectId: string;
  rowIndex: number;
  columnIndex: number;
  text: string;
}) {
  const cellLocation = {
    rowIndex: input.rowIndex,
    columnIndex: input.columnIndex,
  };
  return batchUpdateGoogleSlides({
    workspaceId: input.workspaceId,
    presentationId: input.presentationId,
    requests: [
      {
        deleteText: {
          objectId: input.tableObjectId,
          cellLocation,
          textRange: { type: "ALL" },
        },
      },
      {
        insertText: {
          objectId: input.tableObjectId,
          cellLocation,
          insertionIndex: 0,
          text: input.text,
        },
      },
    ],
  });
}

export async function replaceGoogleSlidesText(input: {
  workspaceId: string;
  presentationId: string;
  replacements: Array<{ find: string; replace: string }>;
}) {
  return batchUpdateGoogleSlides({
    workspaceId: input.workspaceId,
    presentationId: input.presentationId,
    requests: input.replacements.map((replacement) => ({
      replaceAllText: {
        containsText: {
          text: replacement.find,
          matchCase: true,
        },
        replaceText: replacement.replace,
      },
    })),
  });
}

export async function createNotionPage(input: {
  workspaceId: string;
  title: string;
  content: string;
  links?: Array<{ title: string; url: string }>;
  parentPageId?: string;
}): Promise<NotionMemoryResult> {
  return createNotionMemoryPageFromRunArtifacts({
    workspaceId: input.workspaceId,
    runId: `tool-${Date.now()}`,
    memoryTitle: input.title,
    runSummary: input.content,
    parentPageId: input.parentPageId,
    runOutput: {
      text: input.content,
      connectorResults: (input.links ?? []).map((link) => ({
        source: "artifact",
        title: link.title,
        url: link.url,
        snippet: input.content,
      })),
    },
  });
}

export async function createNotionMemoryPageFromRunArtifacts(
  input: NotionMemoryInput,
): Promise<NotionMemoryResult> {
  const credential = await resolveNotionCredential(input.workspaceId);
  const accessToken = assertNotionAccess(getCredentialPayload(credential));
  const parentPageId =
    input.parentPageId?.trim() ?? getEnv("NOTION_PARENT_PAGE_ID")?.trim();
  if (!parentPageId) {
    throw new Error(
      "Set NOTION_PARENT_PAGE_ID to a workspace page ID before creating memory pages.",
    );
  }

  const title = input.memoryTitle?.trim()
    ? `${input.memoryTitle.trim()} (${new Date().toISOString()})`
    : `Summon Memory · ${input.agentName ?? "Agent run"} · ${input.runId}`;

  const blocks = blocksFromRunArtifacts(input);
  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: {
          title: [
            {
              type: "text",
              text: {
                content: title,
              },
            },
          ],
        },
      },
      children: blocks,
    }),
  });

  const responsePayload = (await readJson(response)) as
    | {
        id?: string;
        url?: string;
        created_time?: string;
      }
    | null;
  if (!response.ok || typeof responsePayload?.id !== "string") {
    const message = await apiErrorMessage("Notion", response, responsePayload);
    throw new Error(message);
  }

  return {
    pageId: responsePayload.id,
    pageUrl: responsePayload.url ?? null,
    createdAt: responsePayload.created_time ?? new Date().toISOString(),
  };
}

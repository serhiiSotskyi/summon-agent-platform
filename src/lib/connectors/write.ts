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

type GoogleSlidesImportResult = {
  fileId: string;
  fileName: string;
  webViewLink: string | null;
  webContentLink: string | null;
  mimeType: string;
};

type GoogleDriveFileResult = {
  fileId: string;
  fileName: string;
  mimeType: string | null;
  webViewLink: string | null;
};

type GoogleSlidesTextElement = {
  objectId: string | null;
  text: string;
  source: "shape" | "table_cell";
  rowIndex?: number;
  columnIndex?: number;
};

const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
const GOOGLE_PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const GOOGLE_SCOPE_WARNING =
  "The Google credential does not include Docs/Sheets/Slides write scopes.";
const NOTION_API_VERSION = "2022-06-28";
const MAX_BLOCK_TEXT_LENGTH = 1800;

function normalizeBinaryData(input: GoogleSlidesImportInput["pptx"]) {
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

function googleFileFields() {
  return "id,name,mimeType,webViewLink";
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

export async function readGoogleSheetRange(input: {
  workspaceId: string;
  spreadsheetId: string;
  range: string;
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
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
}

export async function updateGoogleSheetRange(input: {
  workspaceId: string;
  spreadsheetId: string;
  range: string;
  values: unknown[][];
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
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
}

export async function batchUpdateGoogleSlides(input: {
  workspaceId: string;
  presentationId: string;
  requests: Record<string, unknown>[];
}) {
  const { accessToken } = await googleCredentialAndToken(input.workspaceId);
  const response = await fetch(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(
      input.presentationId,
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
    const message = await apiErrorMessage("Google Slides batchUpdate", response, payload);
    throw new Error(message);
  }

  return payload;
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

import { Prisma } from "@prisma/client";
import { getDb } from "@/lib/db";

const MAX_AGENT_FILE_BYTES = 1_000_000;

export const AGENT_FILE_ROLES = [
  "input_data",
  "helper_code",
  "template",
  "reference",
  "output_destination",
  "other",
] as const;

export type AgentFileRole = (typeof AGENT_FILE_ROLES)[number];

type CreateAgentFileInput = {
  agentId: string;
  workspaceId: string;
  name: string;
  role?: string;
  description?: string;
  sourceType: "uploaded_text" | "external_url";
  url?: string;
  originalFileName?: string;
  mimeType?: string;
  contentText?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
};

function formText(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeRole(value: string | undefined): AgentFileRole {
  return AGENT_FILE_ROLES.includes(value as AgentFileRole)
    ? (value as AgentFileRole)
    : "reference";
}

function isUsableFile(value: FormDataEntryValue): value is File {
  return (
    typeof File !== "undefined" &&
    value instanceof File &&
    value.name.trim().length > 0 &&
    value.size > 0
  );
}

function isTextLikeFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    name.endsWith(".csv") ||
    name.endsWith(".py") ||
    name.endsWith(".txt") ||
    name.endsWith(".json") ||
    name.endsWith(".md") ||
    name.endsWith(".yaml") ||
    name.endsWith(".yml")
  );
}

function labelFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const pathLabel = parsed.pathname
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join(" / ");
    return pathLabel || parsed.hostname;
  } catch {
    return url;
  }
}

export async function createAgentFile(input: CreateAgentFileInput) {
  return getDb().agentFile.create({
    data: {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      name: input.name,
      description: input.description || undefined,
      role: normalizeRole(input.role),
      sourceType: input.sourceType,
      url: input.url || undefined,
      originalFileName: input.originalFileName || undefined,
      mimeType: input.mimeType || undefined,
      contentText: input.contentText || undefined,
      sizeBytes: input.sizeBytes,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonObject)
        : undefined,
    },
  });
}

export async function attachFilesFromFormData({
  agentId,
  workspaceId,
  formData,
}: {
  agentId: string;
  workspaceId: string;
  formData: FormData;
}) {
  const created = [];
  const referenceUrl = formText(formData, "referenceUrl");
  const referenceName = formText(formData, "referenceName", referenceUrl ? labelFromUrl(referenceUrl) : "");
  const referenceRole = normalizeRole(formText(formData, "referenceRole", "reference"));
  const referenceDescription = formText(formData, "referenceDescription");

  if (referenceUrl) {
    created.push(
      await createAgentFile({
        agentId,
        workspaceId,
        name: referenceName,
        role: referenceRole,
        description: referenceDescription,
        sourceType: "external_url",
        url: referenceUrl,
        metadata: {
          addedFrom: "agent_form",
        },
      }),
    );
  }

  const uploadRole = normalizeRole(formText(formData, "uploadedFileRole", "input_data"));
  for (const value of formData.getAll("agentFiles")) {
    if (!isUsableFile(value)) {
      continue;
    }
    if (value.size > MAX_AGENT_FILE_BYTES) {
      throw new Error(
        `${value.name} is too large for direct agent upload. Add it as a Google Drive link instead.`,
      );
    }
    if (!isTextLikeFile(value)) {
      throw new Error(
        `${value.name} is not a supported text file. Upload CSV, Python, TXT, Markdown, JSON, or YAML; use a Drive link for binary files.`,
      );
    }

    created.push(
      await createAgentFile({
        agentId,
        workspaceId,
        name: value.name,
        role: uploadRole,
        sourceType: "uploaded_text",
        originalFileName: value.name,
        mimeType: value.type || "text/plain",
        sizeBytes: value.size,
        contentText: await value.text(),
        metadata: {
          addedFrom: "agent_form",
        },
      }),
    );
  }

  return created;
}

export function buildAgentFilesPromptSection(
  files: Array<{
    name: string;
    role: string;
    sourceType: string;
    url: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    contentText: string | null;
    description: string | null;
  }>,
) {
  if (files.length === 0) {
    return "";
  }

  const serialized = files.map((file) => ({
    name: file.name,
    role: file.role,
    sourceType: file.sourceType,
    url: file.url,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    description: file.description,
    contentPreview: file.contentText
      ? file.contentText.slice(0, 12_000)
      : undefined,
  }));

  return [
    "Agent input files and references:",
    "Use these as run-owned inputs. Do not invent files that are not listed here.",
    "For template URLs, copy the referenced file before making generated outputs.",
    "For uploaded helper code, treat it as reference/sandbox code, not app source code.",
    JSON.stringify(serialized, null, 2),
  ].join("\n");
}

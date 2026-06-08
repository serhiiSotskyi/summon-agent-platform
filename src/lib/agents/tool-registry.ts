import type { ConnectorKey } from "@/lib/connectors/catalog";

export const TOOL_CALL_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
] as const;

export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export type ToolCallRequest = {
  action: string;
  parameters: Record<string, unknown>;
};

export type ToolCallResult = {
  data?: Record<string, unknown>;
  artifacts?: AgentArtifactRecord[];
};

export type ToolCallLog = {
  toolName: string;
  connectorType: ConnectorKey | (string & {});
  status: ToolCallStatus;
  request?: ToolCallRequest;
  result?: ToolCallResult;
  error?: string | null;
  durationMs?: number;
};

export type AgentArtifactRecord = {
  artifactType: string;
  name: string;
  location?: string;
  mimeType?: string;
  payload?: Record<string, unknown>;
};

export function isToolCallStatus(value: string): value is ToolCallStatus {
  return TOOL_CALL_STATUSES.includes(value as ToolCallStatus);
}

export function toToolCallLog(value: ToolCallLog) {
  return {
    ...value,
    loggedAt: new Date().toISOString(),
  } satisfies ToolCallLog & { loggedAt: string };
}

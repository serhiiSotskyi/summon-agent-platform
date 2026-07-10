import type { McpUserContext } from "@/lib/mcp/context";
import { callMcpTool, MCP_TOOLS } from "@/lib/mcp/tools";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

const SERVER_INSTRUCTIONS =
  "Use Summon to create durable team automations. Create agents as drafts first, attach references, run a manual test, inspect results, then activate schedules only when output is acceptable. Respect Summon approvals for protected actions.";

type JsonRpcId = number | string | null;

type JsonRpcRequest = {
  id?: JsonRpcId;
  jsonrpc?: "2.0";
  method?: string;
  params?: unknown;
};

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

function hasRequestId(message: JsonRpcRequest) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

function getToolCallParams(params: unknown) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("tools/call params must be an object.");
  }

  const record = params as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new Error("tools/call params.name is required.");
  }

  return {
    name: record.name,
    arguments: record.arguments,
  };
}

export async function handleMcpMessage({
  context,
  message,
}: {
  context: McpUserContext;
  message: unknown;
}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request.");
  }

  const request = message as JsonRpcRequest;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(request.id, -32600, "Invalid JSON-RPC request.");
  }

  if (!hasRequestId(request)) {
    if (request.method === "notifications/initialized") {
      return null;
    }

    return null;
  }

  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: "summon-agent-platform",
          title: "Summon Agent Platform",
          version: "0.1.0",
        },
        instructions: SERVER_INSTRUCTIONS,
      });
    }

    if (request.method === "ping") {
      return jsonRpcResult(request.id, {});
    }

    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, {
        tools: MCP_TOOLS,
      });
    }

    if (request.method === "tools/call") {
      const toolCall = getToolCallParams(request.params);
      const result = await callMcpTool({
        arguments: toolCall.arguments,
        context,
        name: toolCall.name,
      });

      return jsonRpcResult(request.id, result);
    }

    return jsonRpcError(request.id, -32601, `Unsupported MCP method: ${request.method}`);
  } catch (error) {
    return jsonRpcError(
      request.id,
      -32602,
      error instanceof Error ? error.message : "Invalid MCP request.",
    );
  }
}

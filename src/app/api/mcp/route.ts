import { NextResponse, type NextRequest } from "next/server";
import { getMcpUserContextFromRequest } from "@/lib/mcp/context";
import { unauthorizedMcpResponse } from "@/lib/mcp/oauth";
import { handleMcpMessage, MCP_PROTOCOL_VERSION } from "@/lib/mcp/protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isAllowedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }

  if (process.env.NODE_ENV !== "production" && origin.startsWith("http://localhost")) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return (
      parsed.hostname === "claude.ai" ||
      parsed.hostname.endsWith(".claude.ai") ||
      parsed.hostname === "anthropic.com" ||
      parsed.hostname.endsWith(".anthropic.com") ||
      parsed.hostname.endsWith(".summon.co") ||
      parsed.hostname.endsWith(".vercel.app")
    );
  } catch {
    return false;
  }
}

function protocolHeaders() {
  return {
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Cache-Control": "no-store",
  };
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "authorization, content-type, mcp-protocol-version",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function GET(request: NextRequest) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Unsupported Origin." }, { status: 403 });
  }

  const context = await getMcpUserContextFromRequest(request);
  if (!context) {
    return unauthorizedMcpResponse(request);
  }

  return new Response(null, {
    status: 405,
    headers: {
      ...protocolHeaders(),
      Allow: "POST",
    },
  });
}

export async function POST(request: NextRequest) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Unsupported Origin." }, { status: 403 });
  }

  const context = await getMcpUserContextFromRequest(request);
  if (!context) {
    return unauthorizedMcpResponse(request);
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON body." },
      },
      { status: 400, headers: protocolHeaders() },
    );
  }

  const response = await handleMcpMessage({ context, message });
  if (!response) {
    return new Response(null, {
      status: 202,
      headers: protocolHeaders(),
    });
  }

  return NextResponse.json(response, {
    headers: protocolHeaders(),
  });
}

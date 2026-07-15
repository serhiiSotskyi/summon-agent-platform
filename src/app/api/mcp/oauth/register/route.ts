import { NextResponse, type NextRequest } from "next/server";
import { createMcpClient, getMcpBaseUrl, mcpCorsHeaders } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { Allow: "POST, OPTIONS", ...mcpCorsHeaders() },
  });
}

function isAllowedRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return true;
    }

    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter(
        (value): value is string =>
          typeof value === "string" && isAllowedRedirectUri(value),
      )
    : [];

  if (redirectUris.length === 0) {
    return NextResponse.json(
      {
        error: "invalid_redirect_uris",
        error_description:
          "At least one HTTPS or loopback HTTP redirect URI is required.",
      },
      { status: 400, headers: mcpCorsHeaders() },
    );
  }

  const clientId = createMcpClient({
    clientName:
      typeof body.client_name === "string" ? body.client_name : "Claude",
    redirectUris,
  });
  const now = Math.floor(Date.now() / 1000);

  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: now,
      client_name:
        typeof body.client_name === "string" ? body.client_name : "Claude",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: redirectUris,
      response_types: ["code"],
      scope: "summon:read summon:write",
      token_endpoint_auth_method: "none",
      token_endpoint: `${getMcpBaseUrl(request)}/api/mcp/oauth/token`,
    },
    {
      status: 201,
      headers: { "Cache-Control": "no-store", ...mcpCorsHeaders() },
    },
  );
}

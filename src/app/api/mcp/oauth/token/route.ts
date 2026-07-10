import { NextResponse, type NextRequest } from "next/server";
import {
  createMcpAccessToken,
  createMcpRefreshToken,
  verifyMcpAuthorizationCode,
  verifyMcpRefreshToken,
  verifyPkceChallenge,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function parseTokenRequest(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }

  const formData = await request.formData();
  return Object.fromEntries(
    Array.from(formData.entries()).map(([key, value]) => [
      key,
      typeof value === "string" ? value : "",
    ]),
  );
}

function textField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function basicAuthClientId(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return null;
  }

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const [clientId] = decoded.split(":");
    return clientId?.trim() || null;
  } catch {
    return null;
  }
}

function tokenError(error: string, description: string, status = 400) {
  return NextResponse.json(
    {
      error,
      error_description: description,
    },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function tokenResponse(input: { scope: string; userId: string }) {
  const access = createMcpAccessToken(input);
  const refresh = createMcpRefreshToken(input);

  return NextResponse.json(
    {
      access_token: access.accessToken,
      expires_in: access.expiresIn,
      refresh_token: refresh.refreshToken,
      scope: input.scope,
      token_type: "Bearer",
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function POST(request: NextRequest) {
  const body = await parseTokenRequest(request);
  const grantType = textField(body, "grant_type");

  if (grantType === "authorization_code") {
    const code = textField(body, "code");
    const clientId = textField(body, "client_id") ?? basicAuthClientId(request);
    const redirectUri = textField(body, "redirect_uri");
    const codeVerifier = textField(body, "code_verifier");

    if (!code || !clientId || !redirectUri || !codeVerifier) {
      return tokenError(
        "invalid_request",
        "code, client_id, redirect_uri, and code_verifier are required.",
      );
    }

    const codePayload = verifyMcpAuthorizationCode(code);
    if (!codePayload) {
      return tokenError("invalid_grant", "Invalid or expired authorization code.");
    }

    if (
      codePayload.client_id !== clientId ||
      codePayload.redirect_uri !== redirectUri
    ) {
      return tokenError("invalid_grant", "Authorization code binding mismatch.");
    }

    if (
      !verifyPkceChallenge({
        codeChallenge: codePayload.code_challenge,
        codeChallengeMethod: codePayload.code_challenge_method,
        codeVerifier,
      })
    ) {
      return tokenError("invalid_grant", "PKCE verification failed.");
    }

    return tokenResponse({
      scope: codePayload.scope,
      userId: codePayload.sub,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = textField(body, "refresh_token");
    if (!refreshToken) {
      return tokenError("invalid_request", "refresh_token is required.");
    }

    const refreshPayload = verifyMcpRefreshToken(refreshToken);
    if (!refreshPayload) {
      return tokenError("invalid_grant", "Invalid or expired refresh token.");
    }

    return tokenResponse({
      scope: refreshPayload.scope,
      userId: refreshPayload.sub,
    });
  }

  return tokenError(
    "unsupported_grant_type",
    "Summon MCP supports authorization_code and refresh_token grants.",
  );
}

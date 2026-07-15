import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

const DEFAULT_AUTH_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_SCOPE = "summon:read summon:write";

type SignedPayload = {
  exp: number;
  iat: number;
  jti: string;
  typ: string;
};

export type McpAuthCodePayload = SignedPayload & {
  client_id: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  redirect_uri: string;
  scope: string;
  sub: string;
  typ: "mcp_auth_code";
};

export type McpAccessTokenPayload = SignedPayload & {
  scope: string;
  sub: string;
  typ: "mcp_access_token";
};

export type McpRefreshTokenPayload = SignedPayload & {
  scope: string;
  sub: string;
  typ: "mcp_refresh_token";
};

export type McpClientPayload = SignedPayload & {
  client_name?: string;
  redirect_uris: string[];
  typ: "mcp_client";
};

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number(value) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getMcpSecret() {
  const secret =
    getEnv("SUMMON_MCP_OAUTH_SECRET") ??
    getEnv("CONNECTOR_ENCRYPTION_KEY") ??
    getEnv("CLERK_SECRET_KEY");

  if (!secret) {
    throw new Error(
      "Missing MCP OAuth signing secret. Add SUMMON_MCP_OAUTH_SECRET, CONNECTOR_ENCRYPTION_KEY, or CLERK_SECRET_KEY.",
    );
  }

  return secret;
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(unsigned: string) {
  return createHmac("sha256", getMcpSecret()).update(unsigned).digest("base64url");
}

function expiresAt(ttlSeconds: number) {
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

function commonPayload<T extends string>(
  typ: T,
  ttlSeconds: number,
): SignedPayload & { typ: T } {
  return {
    exp: expiresAt(ttlSeconds),
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString("base64url"),
    typ,
  };
}

function signPayload(payload: Record<string, unknown>) {
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function verifyPayload<T extends SignedPayload>(token: string, typ: T["typ"]) {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) {
    return null;
  }

  const expected = sign(body);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body)) as T;
    if (payload.typ !== typ || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function getMcpBaseUrl(request: Request) {
  const configured = getEnv("APP_URL") ?? getEnv("NEXT_PUBLIC_APP_URL");
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function getMcpScope(scope?: string | null) {
  return scope?.trim() || DEFAULT_SCOPE;
}

export function getMcpAccessTokenTtlSeconds() {
  return parsePositiveInteger(
    getEnv("SUMMON_MCP_ACCESS_TOKEN_TTL_SECONDS"),
    DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  );
}

export function getMcpRefreshTokenTtlSeconds() {
  return parsePositiveInteger(
    getEnv("SUMMON_MCP_REFRESH_TOKEN_TTL_SECONDS"),
    DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  );
}

export function createMcpClient(input: {
  clientName?: string;
  redirectUris: string[];
}) {
  return signPayload({
    ...commonPayload("mcp_client", 365 * 24 * 60 * 60),
    client_name: input.clientName,
    redirect_uris: input.redirectUris,
  } satisfies McpClientPayload);
}

export function verifyMcpClient(clientId: string) {
  return verifyPayload<McpClientPayload>(clientId, "mcp_client");
}

export function createMcpAuthorizationCode(input: {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
  redirectUri: string;
  scope?: string | null;
  userId: string;
}) {
  return signPayload({
    ...commonPayload("mcp_auth_code", DEFAULT_AUTH_CODE_TTL_SECONDS),
    client_id: input.clientId,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    redirect_uri: input.redirectUri,
    scope: getMcpScope(input.scope),
    sub: input.userId,
  } satisfies McpAuthCodePayload);
}

export function verifyMcpAuthorizationCode(code: string) {
  return verifyPayload<McpAuthCodePayload>(code, "mcp_auth_code");
}

export function createMcpAccessToken(input: { scope: string; userId: string }) {
  const expiresIn = getMcpAccessTokenTtlSeconds();
  return {
    accessToken: signPayload({
      ...commonPayload("mcp_access_token", expiresIn),
      scope: input.scope,
      sub: input.userId,
    } satisfies McpAccessTokenPayload),
    expiresIn,
  };
}

export function verifyMcpAccessToken(token: string) {
  return verifyPayload<McpAccessTokenPayload>(token, "mcp_access_token");
}

export function createMcpRefreshToken(input: { scope: string; userId: string }) {
  const expiresIn = getMcpRefreshTokenTtlSeconds();
  return {
    refreshToken: signPayload({
      ...commonPayload("mcp_refresh_token", expiresIn),
      scope: input.scope,
      sub: input.userId,
    } satisfies McpRefreshTokenPayload),
    expiresIn,
  };
}

export function verifyMcpRefreshToken(token: string) {
  return verifyPayload<McpRefreshTokenPayload>(token, "mcp_refresh_token");
}

export function extractBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function verifyPkceChallenge(input: {
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
  codeVerifier: string;
}) {
  if (input.codeChallengeMethod === "plain") {
    return input.codeVerifier === input.codeChallenge;
  }

  return (
    createHash("sha256")
      .update(input.codeVerifier)
      .digest("base64url") === input.codeChallenge
  );
}

export function buildMcpProtectedResourceMetadata(request: Request) {
  const baseUrl = getMcpBaseUrl(request);
  return {
    resource: `${baseUrl}/api/mcp`,
    resource_name: "Agent Platform",
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["summon:read", "summon:write"],
  };
}

export function buildMcpAuthorizationServerMetadata(request: Request) {
  const baseUrl = getMcpBaseUrl(request);
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/mcp/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/mcp/oauth/token`,
    registration_endpoint: `${baseUrl}/api/mcp/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["summon:read", "summon:write"],
    service_documentation: `${baseUrl}/app/help`,
  };
}

export function unauthorizedMcpResponse(request: Request) {
  const baseUrl = getMcpBaseUrl(request);
  return Response.json(
    {
      error: "unauthorized",
      error_description: "Authenticate this Claude connector with Agent Platform.",
    },
    {
      status: 401,
      headers: {
        ...mcpCorsHeaders(),
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${DEFAULT_SCOPE}"`,
      },
    },
  );
}

export function mcpCorsHeaders() {
  return {
    "Access-Control-Allow-Headers":
      "authorization, content-type, mcp-protocol-version",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  };
}

import { getConnector } from "@/lib/connectors/catalog";
import {
  decryptConnectorCredentials,
  encryptConnectorCredentials,
} from "@/lib/connectors/credentials";
import { getDb } from "@/lib/db";
import { getEnv, requireEnv } from "@/lib/env";

export type OAuthState = {
  source: string;
  workspaceId: string;
  userId: string;
  nonce: string;
  createdAt: string;
};

type OAuthTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  scope?: string;
  token_type?: string;
  [key: string]: unknown;
};

type ExchangeInput = {
  code: string;
  redirectUri: string;
  state: OAuthState;
  userId: string;
  workspaceId: string;
};

function assertStateMatches(input: ExchangeInput) {
  if (input.state.workspaceId !== input.workspaceId) {
    throw new Error("OAuth callback workspace did not match the active workspace.");
  }

  if (input.state.userId !== input.userId) {
    throw new Error("OAuth callback user did not match the signed-in user.");
  }
}

async function assertActiveMember(workspaceId: string, userId: string) {
  const membership = await getDb().workspaceMembership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
  });

  if (!membership || membership.status !== "ACTIVE") {
    throw new Error("You do not have permission to connect this workspace.");
  }
}

async function readOAuthResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as OAuthTokenPayload;
  } catch {
    return { error: text };
  }
}

function sanitizeOAuthText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .replace(/GOCSPX-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b4\/[A-Za-z0-9_-]+\b/g, "[redacted]")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

function formatOAuthExchangeError(provider: string, payload: OAuthTokenPayload) {
  const code = sanitizeOAuthText(payload.error);
  const description = sanitizeOAuthText(payload.error_description);
  const detail = [code, description].filter(Boolean).join(": ");

  return detail
    ? `${provider} OAuth token exchange failed: ${detail}`
    : `${provider} OAuth token exchange failed.`;
}

async function saveConnectorCredential({
  connectorType,
  createdById,
  displayName,
  payload,
  workspaceId,
}: {
  connectorType: string;
  createdById: string;
  displayName: string;
  payload: unknown;
  workspaceId: string;
}) {
  const db = getDb();
  const encryptedCredentials = encryptConnectorCredentials(payload);
  const existing = await db.connectorCredential.findFirst({
    where: {
      workspaceId,
      connectorType,
    },
  });

  if (existing) {
    return db.connectorCredential.update({
      where: { id: existing.id },
      data: {
        displayName,
        encryptedCredentials,
        status: "ACTIVE",
        createdById,
        sharedWithWorkspace: true,
      },
    });
  }

  return db.connectorCredential.create({
    data: {
      workspaceId,
      connectorType,
      displayName,
      encryptedCredentials,
      status: "ACTIVE",
      createdById,
      sharedWithWorkspace: true,
    },
  });
}

export function encodeOAuthState(input: {
  source: string;
  workspaceId: string;
  userId: string;
}) {
  return Buffer.from(
    JSON.stringify({
      ...input,
      nonce: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    } satisfies OAuthState),
  ).toString("base64url");
}

export function decodeOAuthState(rawState: string | null) {
  if (!rawState) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(rawState, "base64url").toString("utf8")) as
      | OAuthState
      | null;
  } catch {
    return null;
  }
}

export async function exchangeGoogleOAuthCode(input: ExchangeInput) {
  assertStateMatches(input);
  await assertActiveMember(input.workspaceId, input.userId);

  const connector = getConnector(input.state.source);
  if (!connector || connector.provider !== "google") {
    throw new Error("Unknown Google connector source.");
  }

  const body = new URLSearchParams({
    code: input.code,
    client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await readOAuthResponse(response);

  if (!response.ok || !payload.access_token) {
    throw new Error(formatOAuthExchangeError("Google", payload));
  }

  const credential = await saveConnectorCredential({
    workspaceId: input.workspaceId,
    connectorType: connector.key,
    displayName: `${connector.name} shared credential`,
    createdById: input.userId,
    payload: {
      provider: "google",
      connectorType: connector.key,
      token: payload,
      connectedAt: new Date().toISOString(),
    },
  });

  await runConnectorHealthCheck({ credentialId: credential.id });
  return credential;
}

export async function exchangeNotionOAuthCode(input: ExchangeInput) {
  assertStateMatches(input);
  await assertActiveMember(input.workspaceId, input.userId);

  const authHeader = Buffer.from(
    `${requireEnv("NOTION_OAUTH_CLIENT_ID")}:${requireEnv("NOTION_OAUTH_CLIENT_SECRET")}`,
  ).toString("base64");
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  const payload = await readOAuthResponse(response);

  if (!response.ok || !payload.access_token) {
    throw new Error(formatOAuthExchangeError("Notion", payload));
  }

  const workspaceName =
    typeof payload.workspace_name === "string" && payload.workspace_name.trim()
      ? payload.workspace_name
      : "Notion shared credential";
  const credential = await saveConnectorCredential({
    workspaceId: input.workspaceId,
    connectorType: "notion",
    displayName: workspaceName,
    createdById: input.userId,
    payload: {
      provider: "notion",
      connectorType: "notion",
      token: payload,
      connectedAt: new Date().toISOString(),
    },
  });

  await runConnectorHealthCheck({ credentialId: credential.id });
  return credential;
}

export async function runConnectorHealthCheck({
  credentialId,
}: {
  credentialId: string;
}) {
  const db = getDb();
  const credential = await db.connectorCredential.findUnique({
    where: { id: credentialId },
  });

  if (!credential) {
    throw new Error("Connector credential not found.");
  }

  try {
    const payload = decryptConnectorCredentials<{
      provider: string;
      token?: OAuthTokenPayload;
    }>(credential.encryptedCredentials);
    const accessToken = payload.token?.access_token;

    if (!accessToken) {
      throw new Error("Credential does not include an access token.");
    }

    if (credential.connectorType === "notion") {
      const response = await fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Notion-Version": "2022-06-28",
        },
      });

      if (!response.ok) {
        throw new Error("Notion health check failed.");
      }
    } else {
      const tokenInfoUrl = new URL("https://www.googleapis.com/oauth2/v1/tokeninfo");
      tokenInfoUrl.searchParams.set("access_token", accessToken);
      const response = await fetch(tokenInfoUrl);

      if (!response.ok) {
        throw new Error("Google health check failed.");
      }
    }

    return db.connectorCredential.update({
      where: { id: credential.id },
      data: {
        status: "ACTIVE",
        lastHealthCheckAt: new Date(),
      },
    });
  } catch (error) {
    await db.connectorCredential.update({
      where: { id: credential.id },
      data: {
        status: "ERROR",
        lastHealthCheckAt: new Date(),
      },
    });
    throw error;
  }
}

export function hasGoogleOAuthEnv() {
  return Boolean(
    getEnv("GOOGLE_OAUTH_CLIENT_ID") && getEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
  );
}

export function hasNotionOAuthEnv() {
  return Boolean(
    getEnv("NOTION_OAUTH_CLIENT_ID") && getEnv("NOTION_OAUTH_CLIENT_SECRET"),
  );
}

export function hasConnectorEncryptionEnv() {
  return Boolean(getEnv("CONNECTOR_ENCRYPTION_KEY"));
}

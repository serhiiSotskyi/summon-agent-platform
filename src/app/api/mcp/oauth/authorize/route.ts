import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedDbUser } from "@/lib/app/context";
import {
  createMcpAuthorizationCode,
  getMcpBaseUrl,
  getMcpScope,
  verifyMcpClient,
} from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function redirectWithOAuthError({
  error,
  errorDescription,
  redirectUri,
  state,
}: {
  error: string;
  errorDescription?: string;
  redirectUri?: string | null;
  state?: string | null;
}) {
  if (!redirectUri) {
    return NextResponse.json(
      {
        error,
        error_description: errorDescription,
      },
      { status: 400 },
    );
  }

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("error", error);
  if (errorDescription) {
    redirectUrl.searchParams.set("error_description", errorDescription);
  }
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  return NextResponse.redirect(redirectUrl);
}

function isAllowedRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return true;
    }

    return (
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function validateSignedClientRedirect(clientId: string, redirectUri: string) {
  const client = verifyMcpClient(clientId);
  if (!client) {
    return true;
  }

  return client.redirect_uris.includes(redirectUri);
}

function buildApprovalHtml(input: {
  approveUrl: string;
  denyUrl: string;
  redirectUri: string;
  scope: string;
  userEmail: string;
  userName: string | null;
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize Summon for Claude</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0d0f0f;
        color: #f4f4f5;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(520px, calc(100vw - 32px));
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        background: rgba(24,24,27,0.9);
        padding: 28px;
      }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { color: #a1a1aa; line-height: 1.6; }
      code {
        color: #d9f99d;
        overflow-wrap: anywhere;
      }
      .actions { display: flex; gap: 12px; margin-top: 24px; }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 0 16px;
        border-radius: 8px;
        color: #ecfdf5;
        text-decoration: none;
      }
      .primary { background: #059669; }
      .secondary { background: #27272a; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize Claude to use Summon</h1>
      <p>
        You are signed in as <strong>${escapeHtml(input.userName ?? input.userEmail)}</strong>.
        Claude will be able to manage Summon agents, runs, schedules, references, and approvals using your current Summon workspace permissions.
      </p>
      <p>Requested scopes: <code>${escapeHtml(input.scope)}</code></p>
      <p>Claude redirect: <code>${escapeHtml(input.redirectUri)}</code></p>
      <div class="actions">
        <a class="primary" href="${escapeHtml(input.approveUrl)}">Authorize Claude</a>
        <a class="secondary" href="${escapeHtml(input.denyUrl)}">Deny</a>
      </div>
    </main>
  </body>
</html>`;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const scope = getMcpScope(url.searchParams.get("scope"));
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod =
    url.searchParams.get("code_challenge_method") === "plain" ? "plain" : "S256";

  if (responseType !== "code") {
    return redirectWithOAuthError({
      error: "unsupported_response_type",
      errorDescription: "Summon MCP supports only authorization code flow.",
      redirectUri,
      state,
    });
  }

  if (!clientId || !redirectUri || !codeChallenge) {
    return redirectWithOAuthError({
      error: "invalid_request",
      errorDescription:
        "client_id, redirect_uri, and PKCE code_challenge are required.",
      redirectUri,
      state,
    });
  }

  if (
    !isAllowedRedirectUri(redirectUri) ||
    !validateSignedClientRedirect(clientId, redirectUri)
  ) {
    return NextResponse.json(
      {
        error: "invalid_request",
        error_description: "Invalid OAuth redirect_uri.",
      },
      { status: 400 },
    );
  }

  const authenticated = await getAuthenticatedDbUser();
  if (!authenticated) {
    const returnPath = `${url.pathname}${url.search}`;
    const signInUrl = new URL("/sign-in", getMcpBaseUrl(request));
    signInUrl.searchParams.set("redirect_url", returnPath);
    return NextResponse.redirect(signInUrl);
  }

  if (url.searchParams.get("approve") === "1") {
    const code = createMcpAuthorizationCode({
      clientId,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      scope,
      userId: authenticated.user.id,
    });
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) {
      redirectUrl.searchParams.set("state", state);
    }

    return NextResponse.redirect(redirectUrl);
  }

  const approveUrl = new URL(url.toString());
  approveUrl.searchParams.set("approve", "1");
  const denyUrl = new URL(redirectUri);
  denyUrl.searchParams.set("error", "access_denied");
  if (state) {
    denyUrl.searchParams.set("state", state);
  }

  return new Response(
    buildApprovalHtml({
      approveUrl: approveUrl.toString(),
      denyUrl: denyUrl.toString(),
      redirectUri,
      scope,
      userEmail: authenticated.user.email,
      userName: authenticated.user.name,
    }),
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
}

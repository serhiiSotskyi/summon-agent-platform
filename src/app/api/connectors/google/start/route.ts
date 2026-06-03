import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserContext } from "@/lib/app/context";
import { getConnector } from "@/lib/connectors/catalog";
import {
  encodeOAuthState,
  hasConnectorEncryptionEnv,
  hasGoogleOAuthEnv,
} from "@/lib/connectors/oauth";
import { getEnv } from "@/lib/env";

function buildRedirectUri(request: NextRequest) {
  return (
    getEnv("GOOGLE_OAUTH_REDIRECT_URI") ??
    new URL("/api/connectors/google/callback", request.url).toString()
  );
}

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source") ?? "google-ads";
  const workspaceId = request.nextUrl.searchParams.get("workspace") ?? undefined;
  const connector = getConnector(source);

  if (!connector || connector.provider !== "google") {
    return NextResponse.json(
      { error: "Unknown Google connector source." },
      { status: 404 },
    );
  }

  const context = await getCurrentUserContext(workspaceId);
  if (!context.isAuthenticated) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  if (!hasGoogleOAuthEnv() || !hasConnectorEncryptionEnv()) {
    return NextResponse.json(
      {
        error: "Missing Google OAuth or connector encryption environment configuration.",
        connector: connector.key,
      },
      { status: 501 },
    );
  }

  const oauthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  oauthUrl.searchParams.set("client_id", getEnv("GOOGLE_OAUTH_CLIENT_ID")!);
  oauthUrl.searchParams.set("redirect_uri", buildRedirectUri(request));
  oauthUrl.searchParams.set("response_type", "code");
  oauthUrl.searchParams.set("access_type", "offline");
  oauthUrl.searchParams.set("prompt", "consent");
  oauthUrl.searchParams.set("include_granted_scopes", "false");
  oauthUrl.searchParams.set("scope", connector.scopes.join(" "));
  oauthUrl.searchParams.set(
    "state",
    encodeOAuthState({
      source: connector.key,
      workspaceId: context.workspace.id,
      userId: context.user.id,
    }),
  );

  return NextResponse.redirect(oauthUrl);
}

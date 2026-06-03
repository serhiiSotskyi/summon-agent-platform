import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserContext } from "@/lib/app/context";
import {
  encodeOAuthState,
  hasConnectorEncryptionEnv,
  hasNotionOAuthEnv,
} from "@/lib/connectors/oauth";
import { getEnv } from "@/lib/env";

function buildRedirectUri(request: NextRequest) {
  return (
    getEnv("NOTION_OAUTH_REDIRECT_URI") ??
    new URL("/api/connectors/notion/callback", request.url).toString()
  );
}

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspace") ?? undefined;
  const context = await getCurrentUserContext(workspaceId);

  if (!context.isAuthenticated) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  if (!hasNotionOAuthEnv() || !hasConnectorEncryptionEnv()) {
    return NextResponse.json(
      {
        error: "Missing Notion OAuth or connector encryption environment configuration.",
        connector: "notion",
      },
      { status: 501 },
    );
  }

  const oauthUrl = new URL("https://api.notion.com/v1/oauth/authorize");
  oauthUrl.searchParams.set("client_id", getEnv("NOTION_OAUTH_CLIENT_ID")!);
  oauthUrl.searchParams.set("redirect_uri", buildRedirectUri(request));
  oauthUrl.searchParams.set("response_type", "code");
  oauthUrl.searchParams.set("owner", "user");
  oauthUrl.searchParams.set(
    "state",
    encodeOAuthState({
      source: "notion",
      workspaceId: context.workspace.id,
      userId: context.user.id,
    }),
  );

  return NextResponse.redirect(oauthUrl);
}

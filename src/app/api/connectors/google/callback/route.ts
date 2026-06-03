import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserContext } from "@/lib/app/context";
import {
  decodeOAuthState,
  exchangeGoogleOAuthCode,
} from "@/lib/connectors/oauth";
import { getEnv } from "@/lib/env";

function buildRedirectUri(request: NextRequest) {
  return (
    getEnv("GOOGLE_OAUTH_REDIRECT_URI") ??
    new URL("/api/connectors/google/callback", request.url).toString()
  );
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = decodeOAuthState(request.nextUrl.searchParams.get("state"));

  if (!code) {
    return NextResponse.json(
      { error: "Google OAuth callback did not include an authorization code." },
      { status: 400 },
    );
  }

  if (!state) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  const context = await getCurrentUserContext(state.workspaceId);
  if (!context.isAuthenticated) {
    return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  }

  try {
    const credential = await exchangeGoogleOAuthCode({
      code,
      state,
      workspaceId: context.workspace.id,
      userId: context.user.id,
      redirectUri: buildRedirectUri(request),
    });

    return NextResponse.redirect(
      new URL(
        `/app/connectors/${credential.connectorType}?workspace=${context.workspace.id}&connected=1`,
        request.url,
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Google OAuth callback failed.";
    console.error("[connectors.google.callback]", {
      connector: state.source,
      message,
    });

    const redirectUrl = new URL(
      `/app/connectors/${state.source}`,
      request.url,
    );
    redirectUrl.searchParams.set("workspace", context.workspace.id);
    redirectUrl.searchParams.set("connected", "0");
    redirectUrl.searchParams.set("error", message);

    return NextResponse.redirect(redirectUrl);
  }
}

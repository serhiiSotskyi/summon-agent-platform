import { ArrowLeft, ExternalLink, KeyRound, PlugZap } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUserContext } from "@/lib/app/context";
import { demoConnectorStatus } from "@/lib/app/demo";
import { getConnector } from "@/lib/connectors/catalog";
import {
  hasConnectorEncryptionEnv,
  hasGoogleOAuthEnv,
  hasNotionOAuthEnv,
} from "@/lib/connectors/oauth";
import { getDb } from "@/lib/db";

type Params = Promise<{ connectorId: string }>;
type SearchParams = Promise<{
  connected?: string;
  demo?: string;
  error?: string;
  workspace?: string;
}>;

export default async function ConnectorDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ connectorId }, query] = await Promise.all([params, searchParams]);
  const connector = getConnector(connectorId);
  const context = await getCurrentUserContext(query.workspace);

  if (!connector) {
    notFound();
  }

  if (!context.isAuthenticated) {
    return null;
  }

  const demo = query.demo === "1";
  const credential = demo
    ? null
    : await getDb().connectorCredential.findFirst({
        where: {
          workspaceId: context.workspace.id,
          connectorType: connector.key,
        },
      });
  const connected = demo ? demoConnectorStatus[connector.key] : Boolean(credential);
  const missingEnv =
    !hasConnectorEncryptionEnv() ||
    (connector.provider === "google"
      ? !hasGoogleOAuthEnv()
      : !hasNotionOAuthEnv());
  const oauthHref = `${connector.oauthPath}${
    connector.oauthPath.includes("?") ? "&" : "?"
  }workspace=${context.workspace.id}`;

  return (
    <>
      <PageHeader
        actions={
          <Button asChild variant="secondary">
            <Link href={`/app/connectors?workspace=${context.workspace.id}${demo ? "&demo=1" : ""}`}>
              <ArrowLeft aria-hidden />
              All connectors
            </Link>
          </Button>
        }
        description={connector.summary}
        eyebrow={demo ? "Connector - demo" : "Connector"}
        title={connector.name}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.55fr)]">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Connection status</CardTitle>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                OAuth starts from this page. Successful callbacks exchange
                tokens server-side and store encrypted workspace credentials.
              </p>
            </div>
            {demo ? <Badge variant="demo">Demo</Badge> : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">
                    {connected ? "Connected credential" : "No credential"}
                  </p>
                  <p className="mt-1 text-sm text-zinc-500">
                    {credential?.displayName ?? "Workspace shared credential"}
                  </p>
                </div>
                <StatusBadge status={connected ? "ACTIVE" : "MISSING"} />
              </div>
            </div>

            {missingEnv && !demo ? (
              <Alert>
                Missing OAuth environment configuration. Add{" "}
                <code>
                  {connector.provider === "google"
                    ? "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / CONNECTOR_ENCRYPTION_KEY"
                    : "NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET / CONNECTOR_ENCRYPTION_KEY"}
                </code>{" "}
                before this connector can redirect to the provider.
              </Alert>
            ) : null}

            {query.connected === "1" && !demo ? (
              <Alert className="border-emerald-300/20 bg-emerald-300/10 text-emerald-50/90">
                OAuth connected successfully. The credential is encrypted and
                shared with this workspace.
              </Alert>
            ) : null}

            {query.error && !demo ? (
              <Alert className="border-red-300/20 bg-red-300/10 text-red-50/90">
                {query.error}
              </Alert>
            ) : null}

            <Button asChild className="w-full">
              <a href={oauthHref}>
                <PlugZap aria-hidden />
                Start OAuth
                <ExternalLink aria-hidden />
              </a>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Access and scopes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="rounded-md border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm leading-6 text-emerald-50/90">
              <p className="font-medium">{connector.accessModeLabel}</p>
              <p className="mt-1 text-emerald-50/70">
                {connector.accessModeDescription}
              </p>
            </div>
            {connector.scopes.length > 0 ? (
              connector.scopes.map((scope) => (
                <div
                  className="flex gap-3 rounded-md border border-white/10 bg-black/20 p-3 text-xs text-zinc-300"
                  key={scope}
                >
                  <KeyRound aria-hidden className="size-4 shrink-0 text-amber-200" />
                  <span className="break-all font-mono">{scope}</span>
                </div>
              ))
            ) : (
              <p className="rounded-md border border-white/10 bg-black/20 p-3 text-sm leading-6 text-zinc-400">
                Notion scopes are configured in the Notion integration dashboard.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

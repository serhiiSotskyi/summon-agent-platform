import { ArrowUpRight, Cable, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { StatusBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUserContext } from "@/lib/app/context";
import { demoConnectorStatus } from "@/lib/app/demo";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { getDb } from "@/lib/db";

type SearchParams = Promise<{
  workspace?: string;
  demo?: string;
}>;

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const demo = params.demo === "1";
  const credentials = demo
    ? []
    : await getDb().connectorCredential.findMany({
        where: { workspaceId: context.workspace.id },
      });

  return (
    <>
      <PageHeader
        description="Connect tools once at the workspace level, then let agents use them according to their permissions."
        eyebrow={demo ? "Connectors - demo" : "Connectors"}
        title="Tool connections"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {connectorCatalog.map((connector) => {
          const credential = credentials.find(
            (item) => item.connectorType === connector.key,
          );
          const connected = demo ? demoConnectorStatus[connector.key] : Boolean(credential);

          return (
            <Card key={connector.key}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{connector.name}</CardTitle>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                      {connector.summary}
                    </p>
                  </div>
                  {demo ? <Badge variant="demo">Demo</Badge> : null}
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4 flex items-center gap-2">
                  {connected ? (
                    <>
                      <CheckCircle2 aria-hidden className="size-4 text-emerald-200" />
                      <StatusBadge status="ACTIVE" />
                    </>
                  ) : (
                    <StatusBadge status="MISSING" />
                  )}
                </div>
                <Button asChild className="w-full" variant="secondary">
                  <Link
                    href={`/app/connectors/${connector.key}?workspace=${context.workspace.id}${demo ? "&demo=1" : ""}`}
                  >
                    Configure
                    <ArrowUpRight aria-hidden />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!demo && credentials.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            description="Choose a connector above to start OAuth setup. Agents cannot use external systems until credentials are connected."
            icon={Cable}
            title="No live connectors yet"
          />
        </div>
      ) : null}
    </>
  );
}

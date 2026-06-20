import { ExternalLink, Settings } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
import type { ReadinessStatus } from "@/lib/app/readiness";
import { getWorkspaceReadiness } from "@/lib/app/readiness";
import { getDefaultLlmSettings } from "@/lib/env";

type SearchParams = Promise<{ workspace?: string }>;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  const [llm, readiness] = await Promise.all([
    Promise.resolve(getDefaultLlmSettings()),
    getWorkspaceReadiness(context.workspace.id),
  ]);
  const readinessCounts = {
    blocked: readiness.items.filter((item) => item.status === "BLOCKED").length,
    degraded: readiness.items.filter((item) => item.status === "DEGRADED").length,
    ready: readiness.items.filter((item) => item.status === "READY").length,
  };

  return (
    <>
      <PageHeader
        description="Workspace defaults for models, retention, permissions, and future client-facing branding."
        eyebrow="Settings"
        title="Workspace settings"
      />

      <Card className="mb-5">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Production readiness</CardTitle>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Operational checks for the active workspace. These are the
              prerequisites non-technical users need before agents can run
              reliably end to end.
            </p>
          </div>
          <ReadinessBadge status={readiness.status} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <ReadinessCount label="Ready" value={readinessCounts.ready} />
            <ReadinessCount label="Degraded" value={readinessCounts.degraded} />
            <ReadinessCount label="Blocked" value={readinessCounts.blocked} />
          </div>
          <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
            Checked {new Date(readiness.checkedAt).toLocaleString("en-GB")}
          </p>
          <div className="grid gap-3 xl:grid-cols-2">
            {readiness.items.map((item) => (
              <div
                className="rounded-md border border-white/10 bg-black/20 p-4"
                key={item.key}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-white">{item.title}</p>
                  <ReadinessBadge status={item.status} />
                </div>
                <p className="mt-3 text-sm leading-6 text-zinc-300">
                  {item.detail}
                </p>
                {item.action ? (
                  <div className="mt-3 rounded-md border border-amber-300/20 bg-amber-300/10 p-3 text-sm leading-6 text-amber-100">
                    <p>{item.action}</p>
                    {item.href ? (
                      <Button
                        asChild
                        className="mt-3"
                        size="sm"
                        variant="secondary"
                      >
                        {item.href.startsWith("/") ? (
                          <Link href={item.href}>Open action</Link>
                        ) : (
                          <a
                            href={item.href}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open action
                            <ExternalLink aria-hidden />
                          </a>
                        )}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Model defaults</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="provider">Default provider</Label>
              <Select defaultValue={llm.provider} disabled id="provider">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">Default model</Label>
              <Input defaultValue={llm.model} disabled id="model" />
            </div>
            <Alert>
              Settings are displayed from environment defaults for now. The next
              schema step can persist workspace-level defaults.
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Retention and branding</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-sm font-medium text-white">Run retention</p>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Agent outputs and logs are retained for 12 months by default.
              </p>
            </div>
            <div className="rounded-md border border-white/10 bg-black/20 p-4">
              <p className="text-sm font-medium text-white">Client branding</p>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Logo, colors, and client-facing report styling will live here.
              </p>
            </div>
            <Button disabled variant="secondary">
              <Settings aria-hidden />
              Save settings
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ReadinessBadge({ status }: { status: ReadinessStatus }) {
  const variant =
    status === "READY" ? "success" : status === "DEGRADED" ? "warning" : "danger";

  return <Badge variant={variant}>{status.toLowerCase()}</Badge>;
}

function ReadinessCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/20 p-4">
      <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}

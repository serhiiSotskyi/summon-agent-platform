import { Settings } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
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

  const llm = getDefaultLlmSettings();

  return (
    <>
      <PageHeader
        description="Workspace defaults for models, retention, permissions, and future client-facing branding."
        eyebrow="Settings"
        title="Workspace settings"
      />

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

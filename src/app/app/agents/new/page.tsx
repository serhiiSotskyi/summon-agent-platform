import { Bot, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { createAgentDraft } from "../../actions";

type SearchParams = Promise<{ workspace?: string; demo?: string }>;

export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getCurrentUserContext(params.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  return (
    <>
      <PageHeader
        description="Create a draft from plain English, then review generated tools, prompt, permissions, and trigger before activation."
        eyebrow="Agent creator"
        title="New agent"
      />

      <form action={createAgentDraft} className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
        <input name="workspaceId" type="hidden" value={context.workspace.id} />
        <Card>
          <CardHeader>
            <CardTitle>Describe the job</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="prompt">Plain-English prompt</Label>
              <Textarea
                id="prompt"
                name="prompt"
                placeholder="Review paid acquisition performance every Monday and draft a client-ready update."
                required
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Agent name</Label>
                <Input id="name" name="name" placeholder="Optional" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input id="description" name="description" placeholder="Optional" />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="llmProvider">Provider</Label>
                <Select id="llmProvider" name="llmProvider" defaultValue="openai">
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="llmModel">Model</Label>
                <Input id="llmModel" name="llmModel" defaultValue="gpt-4.1" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="triggerType">Trigger</Label>
                <Select id="triggerType" name="triggerType" defaultValue="MANUAL">
                  <option value="MANUAL">Manual</option>
                  <option value="SCHEDULED">Scheduled</option>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule">Schedule description</Label>
              <Input
                id="schedule"
                name="schedule"
                placeholder="Every Monday at 9am"
              />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Tools</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {connectorCatalog.map((connector) => (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-white/10 bg-black/20 p-3 text-sm"
                  key={connector.key}
                >
                  <input
                    className="mt-1 accent-emerald-300"
                    name="tools"
                    type="checkbox"
                    value={connector.key}
                  />
                  <span>
                    <span className="block font-medium text-white">
                      {connector.name}
                    </span>
                    <span className="mt-1 block leading-5 text-zinc-500">
                      {connector.summary}
                    </span>
                  </span>
                </label>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Permissions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="actionPermissionMode">Action access</Label>
                <Select
                  id="actionPermissionMode"
                  name="actionPermissionMode"
                  defaultValue="ASK_BEFORE_CHANGES"
                >
                  <option value="ASK_BEFORE_CHANGES">Ask before changes</option>
                  <option value="FULL_ACCESS">Full access</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="deliveryPermissionMode">Delivery access</Label>
                <Select
                  id="deliveryPermissionMode"
                  name="deliveryPermissionMode"
                  defaultValue="ASK_BEFORE_SENDING"
                >
                  <option value="ASK_BEFORE_SENDING">Ask before sending</option>
                  <option value="SEND_AUTOMATICALLY">Send automatically</option>
                </Select>
              </div>
              <Alert>
                <ShieldCheck aria-hidden className="mb-2 size-4" />
                Protected actions always require approval, even when full access
                is selected.
              </Alert>
              <Button className="w-full" type="submit">
                <Bot aria-hidden />
                Save draft agent
              </Button>
            </CardContent>
          </Card>
        </div>
      </form>
    </>
  );
}

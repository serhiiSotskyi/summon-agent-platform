import { Bot, Link2, Rocket, ShieldCheck } from "lucide-react";
import { AgentFileUploadFields } from "@/components/app/agent-file-upload-fields";
import { AgentReferenceFields } from "@/components/app/agent-reference-fields";
import { AgentStarterBriefs } from "@/components/app/agent-starter-briefs";
import { LlmModelFields } from "@/components/app/llm-model-fields";
import { PageHeader } from "@/components/app/page-header";
import { ScheduleFields } from "@/components/app/schedule-fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
import { getDefaultLlmSettings } from "@/lib/env";
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

  const llmDefaults = getDefaultLlmSettings();

  return (
    <>
      <PageHeader
        description="Create a draft from plain English. Safe workspace tools are enabled automatically; destructive actions still require approval."
        eyebrow="Agent creator"
        title="New agent"
      />

      <form
        action={createAgentDraft}
        className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]"
        encType="multipart/form-data"
      >
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
            <AgentStarterBriefs />
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
              <LlmModelFields
                defaultModel={llmDefaults.model}
                defaultProvider={llmDefaults.provider}
                workspaceId={context.workspace.id}
              />
              <div className="space-y-2">
                <Label htmlFor="triggerType">Trigger</Label>
                <Select id="triggerType" name="triggerType" defaultValue="MANUAL">
                  <option value="MANUAL">Manual</option>
                  <option value="SCHEDULED">Scheduled</option>
                </Select>
              </div>
            </div>
            <div className="space-y-4 rounded-md border border-white/10 bg-black/20 p-4">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-white">
                  <Link2 aria-hidden className="size-4 text-emerald-200" />
                  Files and references
                </p>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Attach the inputs this agent should use: templates, Drive or
                  Notion links, exported CSVs, or helper Python. Large Google
                  files should be added as links.
                </p>
              </div>
              <AgentReferenceFields idPrefix="new-reference" />
              <AgentFileUploadFields idPrefix="new-agent-files" />
            </div>
            <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-4">
              <div>
                <p className="text-sm font-medium text-white">Schedule</p>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Used only when Trigger is Scheduled. Draft agents do not run until activated.
                </p>
              </div>
              <ScheduleFields />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-5">
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
                Agents can automatically search connected memory, run sandbox
                code, create files, copy templates, and edit files created by
                their own run. Protected actions always require approval, even
                when full access is selected.
              </Alert>
              <div className="grid gap-3">
                <Button className="w-full" name="intent" type="submit" value="activate">
                  <Rocket aria-hidden />
                  Save and activate
                </Button>
                <Button
                  className="w-full"
                  name="intent"
                  type="submit"
                  value="draft"
                  variant="secondary"
                >
                  <Bot aria-hidden />
                  Save draft
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </form>
    </>
  );
}

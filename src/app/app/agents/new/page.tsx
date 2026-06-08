import { Bot, FileUp, Link2, Rocket, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { DEFAULT_SCHEDULE_TIMEZONE } from "@/lib/agents/schedules";
import { QBR_GENERATE_DECK_TOOL } from "@/lib/tools/qbr";
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
              <div className="grid gap-4 md:grid-cols-[1fr_180px]">
                <div className="space-y-2">
                  <Label htmlFor="referenceUrl">Reference URL</Label>
                  <Input
                    id="referenceUrl"
                    name="referenceUrl"
                    placeholder="Google Slides, Sheets, Drive, Notion, or Looker Studio URL"
                    type="url"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="referenceRole">Role</Label>
                  <Select id="referenceRole" name="referenceRole" defaultValue="reference">
                    <option value="template">Template</option>
                    <option value="input_data">Input data</option>
                    <option value="helper_code">Helper code</option>
                    <option value="reference">Reference</option>
                    <option value="output_destination">Output destination</option>
                    <option value="other">Other</option>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="referenceName">Reference name</Label>
                  <Input
                    id="referenceName"
                    name="referenceName"
                    placeholder="Optional label, e.g. quarterly report template"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="referenceDescription">Reference notes</Label>
                  <Input
                    id="referenceDescription"
                    name="referenceDescription"
                    placeholder="Optional instruction for this file"
                  />
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-[1fr_180px]">
                <div className="space-y-2">
                  <Label htmlFor="agentFiles">Upload small text files</Label>
                  <Input
                    id="agentFiles"
                    multiple
                    name="agentFiles"
                    type="file"
                    accept=".csv,.py,.txt,.md,.json,.yaml,.yml,text/*,application/json"
                  />
                  <p className="text-xs leading-5 text-zinc-500">
                    CSV, Python, TXT, Markdown, JSON, or YAML up to 1 MB each.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="uploadedFileRole">Upload role</Label>
                  <Select
                    id="uploadedFileRole"
                    name="uploadedFileRole"
                    defaultValue="input_data"
                  >
                    <option value="input_data">Input data</option>
                    <option value="helper_code">Helper code</option>
                    <option value="template">Template</option>
                    <option value="reference">Reference</option>
                    <option value="other">Other</option>
                  </Select>
                </div>
              </div>
            </div>
            <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-4">
              <div>
                <p className="text-sm font-medium text-white">Schedule</p>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Used only when Trigger is Scheduled. Draft agents do not run until activated.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="scheduleFrequency">Frequency</Label>
                  <Select
                    id="scheduleFrequency"
                    name="scheduleFrequency"
                    defaultValue="DAILY"
                  >
                    <option value="HOURLY">Hourly</option>
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scheduleTimeOfDay">Time</Label>
                  <Input
                    id="scheduleTimeOfDay"
                    name="scheduleTimeOfDay"
                    type="time"
                    defaultValue="09:00"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scheduleMinute">Hourly minute</Label>
                  <Input
                    id="scheduleMinute"
                    name="scheduleMinute"
                    type="number"
                    min="0"
                    max="59"
                    defaultValue="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scheduleWeekday">Weekday</Label>
                  <Select id="scheduleWeekday" name="scheduleWeekday" defaultValue="1">
                    <option value="1">Monday</option>
                    <option value="2">Tuesday</option>
                    <option value="3">Wednesday</option>
                    <option value="4">Thursday</option>
                    <option value="5">Friday</option>
                    <option value="6">Saturday</option>
                    <option value="0">Sunday</option>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduleTimezone">Timezone</Label>
                <Input
                  id="scheduleTimezone"
                  name="scheduleTimezone"
                  defaultValue={DEFAULT_SCHEDULE_TIMEZONE}
                />
              </div>
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
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm">
                <input
                  className="mt-1 accent-emerald-300"
                  name="tools"
                  type="checkbox"
                  value={QBR_GENERATE_DECK_TOOL}
                />
                <span>
                  <span className="block font-medium text-white">
                    Report/deck generation tool
                  </span>
                  <span className="mt-1 block leading-5 text-emerald-100/80">
                    Uses attached CSV, helper code, and template references to
                    generate report artifacts. It should not rely on hardcoded
                    client files.
                  </span>
                </span>
              </label>
              <Alert>
                <FileUp aria-hidden className="mb-2 size-4" />
                Report generation is one optional tool. The agent still needs
                files or references attached above so it knows what to calculate
                and which template to copy.
              </Alert>
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

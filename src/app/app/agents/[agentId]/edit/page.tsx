import { ArrowLeft, FileUp, Link2, Save } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentFileUploadFields } from "@/components/app/agent-file-upload-fields";
import { AgentReferenceFields } from "@/components/app/agent-reference-fields";
import { LlmModelFields } from "@/components/app/llm-model-fields";
import { PageHeader } from "@/components/app/page-header";
import { ScheduleFields } from "@/components/app/schedule-fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
import { canCreateAgent } from "@/lib/app/permissions";
import { readScheduleConfig } from "@/lib/agents/schedules";
import { getDb } from "@/lib/db";
import { updateAgentConfig } from "../../../actions";

type Params = Promise<{ agentId: string }>;
type SearchParams = Promise<{ workspace?: string }>;

export default async function EditAgentPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);
  const context = await getCurrentUserContext(query.workspace);

  if (!context.isAuthenticated) {
    return null;
  }

  if (!canCreateAgent(context.role)) {
    notFound();
  }

  const agent = await getDb().agent.findFirst({
    where: {
      id: agentId,
      workspaceId: context.workspace.id,
      status: { not: "DELETED" },
    },
  });

  if (!agent) {
    notFound();
  }

  const schedule = readScheduleConfig(agent.triggerConfig);

  return (
    <>
      <PageHeader
        actions={
          <Button asChild variant="secondary">
            <Link href={`/app/agents/${agent.id}?workspace=${context.workspace.id}`}>
              <ArrowLeft aria-hidden />
              Agent
            </Link>
          </Button>
        }
        description="Update model, prompt, permissions, and schedule. Safe workspace tools are enabled automatically."
        eyebrow="Agent editor"
        title={`Edit ${agent.name}`}
      />

      <form
        action={updateAgentConfig}
        className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]"
        encType="multipart/form-data"
      >
        <input name="agentId" type="hidden" value={agent.id} />
        <input name="workspaceId" type="hidden" value={context.workspace.id} />

        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Agent name</Label>
                <Input id="name" name="name" defaultValue={agent.name} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  name="description"
                  defaultValue={agent.description ?? ""}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="systemPrompt">System prompt</Label>
              <Textarea
                id="systemPrompt"
                name="systemPrompt"
                defaultValue={agent.systemPrompt}
                required
              />
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <LlmModelFields
                defaultModel={agent.llmModel}
                defaultProvider={agent.llmProvider}
                workspaceId={context.workspace.id}
              />
              <div className="space-y-2">
                <Label htmlFor="triggerType">Trigger</Label>
                <Select id="triggerType" name="triggerType" defaultValue={agent.triggerType}>
                  <option value="MANUAL">Manual</option>
                  <option value="SCHEDULED">Scheduled</option>
                </Select>
              </div>
            </div>

            <div className="space-y-4 rounded-md border border-white/10 bg-black/20 p-4">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-white">
                  <Link2 aria-hidden className="size-4 text-emerald-200" />
                  Add files and references
                </p>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Add new template links, source data, helper code, or reference
                  files. Existing files are shown on the agent detail page.
                </p>
              </div>
              <AgentReferenceFields idPrefix="edit-reference" />
              <AgentFileUploadFields idPrefix="edit-agent-files" />
              <Alert>
                <FileUp aria-hidden className="mb-2 size-4" />
                Adding files here does not overwrite existing inputs; it adds
                new agent-owned references.
              </Alert>
            </div>

            <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-4">
              <div>
                <p className="text-sm font-medium text-white">Schedule</p>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Used only when Trigger is Scheduled.
                </p>
              </div>
              <ScheduleFields
                defaultFrequency={schedule?.frequency}
                defaultMinute={schedule?.minute}
                defaultTimeOfDay={schedule?.timeOfDay}
                defaultTimezone={schedule?.timezone}
                defaultWeekday={schedule?.weekday}
              />
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
                  defaultValue={agent.actionPermissionMode}
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
                  defaultValue={agent.deliveryPermissionMode}
                >
                  <option value="ASK_BEFORE_SENDING">Ask before sending</option>
                  <option value="SEND_AUTOMATICALLY">Send automatically</option>
                </Select>
              </div>
              <Alert>
                Agents can automatically search connected memory, run sandbox
                code, create files, copy templates, and edit files created by
                their own run. Destructive actions still require approval.
                Active scheduled agents are rescheduled as soon as this form is
                saved.
              </Alert>
              <Button className="w-full" type="submit">
                <Save aria-hidden />
                Save changes
              </Button>
            </CardContent>
          </Card>
        </div>
      </form>
    </>
  );
}

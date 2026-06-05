import { ArrowLeft, Save } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/form";
import { getCurrentUserContext } from "@/lib/app/context";
import { canCreateAgent } from "@/lib/app/permissions";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  readScheduleConfig,
} from "@/lib/agents/schedules";
import { connectorCatalog } from "@/lib/connectors/catalog";
import { getDb } from "@/lib/db";
import { updateAgentConfig } from "../../../actions";

type Params = Promise<{ agentId: string }>;
type SearchParams = Promise<{ workspace?: string }>;

function toolsFromJson(value: unknown) {
  return Array.isArray(value)
    ? value.filter((tool): tool is string => typeof tool === "string")
    : [];
}

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

  const selectedTools = new Set(toolsFromJson(agent.tools));
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
        description="Update model, prompt, tools, permissions, and schedule. Active scheduled agents are rescheduled on save."
        eyebrow="Agent editor"
        title={`Edit ${agent.name}`}
      />

      <form action={updateAgentConfig} className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
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
              <div className="space-y-2">
                <Label htmlFor="llmProvider">Provider</Label>
                <Select id="llmProvider" name="llmProvider" defaultValue={agent.llmProvider}>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="llmModel">Model</Label>
                <Input id="llmModel" name="llmModel" defaultValue={agent.llmModel} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="triggerType">Trigger</Label>
                <Select id="triggerType" name="triggerType" defaultValue={agent.triggerType}>
                  <option value="MANUAL">Manual</option>
                  <option value="SCHEDULED">Scheduled</option>
                </Select>
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-white/10 bg-black/20 p-4">
              <div>
                <p className="text-sm font-medium text-white">Schedule</p>
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                  Used only when Trigger is Scheduled.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="scheduleFrequency">Frequency</Label>
                  <Select
                    id="scheduleFrequency"
                    name="scheduleFrequency"
                    defaultValue={schedule?.frequency ?? "DAILY"}
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
                    defaultValue={schedule?.timeOfDay ?? "09:00"}
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
                    defaultValue={schedule?.minute ?? 0}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scheduleWeekday">Weekday</Label>
                  <Select
                    id="scheduleWeekday"
                    name="scheduleWeekday"
                    defaultValue={String(schedule?.weekday ?? 1)}
                  >
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
                  defaultValue={schedule?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE}
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
                    defaultChecked={selectedTools.has(connector.key)}
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
                Active scheduled agents are rescheduled as soon as this form is saved.
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

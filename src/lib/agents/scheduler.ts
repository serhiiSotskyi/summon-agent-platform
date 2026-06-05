import type { Agent, TriggerType } from "@prisma/client";
import { getDb } from "@/lib/db";
import {
  enqueueScheduledTrigger,
  removeScheduledTrigger,
  type ScheduledAgentTriggerJob,
} from "@/lib/queue/agent-runs";
import { getNextScheduleDate, readScheduleConfig, withAgentSchedulerId } from "./schedules";

type SchedulableAgent = Pick<
  Agent,
  "id" | "workspaceId" | "triggerType" | "triggerConfig" | "status"
>;

function shouldHaveScheduler(agent: SchedulableAgent) {
  return agent.status === "ACTIVE" && agent.triggerType === "SCHEDULED";
}

export async function registerAgentScheduler(agent: SchedulableAgent) {
  if (!shouldHaveScheduler(agent)) {
    await removeScheduledTrigger(agent.id);
    return false;
  }

  const schedule = readScheduleConfig(agent.triggerConfig);
  if (!schedule) {
    await removeScheduledTrigger(agent.id);
    return false;
  }

  const scheduleWithId = withAgentSchedulerId(schedule, agent.id);
  const nextRunAt = getNextScheduleDate(scheduleWithId);
  const data: ScheduledAgentTriggerJob = {
    kind: "scheduled-trigger",
    agentId: agent.id,
    workspaceId: agent.workspaceId,
  };

  if (!nextRunAt) {
    await removeScheduledTrigger(agent.id);
    return false;
  }

  await enqueueScheduledTrigger(data, nextRunAt);

  return true;
}

export async function removeAgentScheduler(agentId: string) {
  return removeScheduledTrigger(agentId);
}

export async function syncActiveAgentSchedulers() {
  const [activeAgents, inactiveAgents] = await Promise.all([
    getDb().agent.findMany({
      where: {
        status: "ACTIVE",
        triggerType: "SCHEDULED" satisfies TriggerType,
      },
      select: {
        id: true,
        workspaceId: true,
        triggerType: true,
        triggerConfig: true,
        status: true,
      },
    }),
    getDb().agent.findMany({
      where: {
        triggerType: "SCHEDULED" satisfies TriggerType,
        status: { not: "ACTIVE" },
      },
      select: { id: true },
    }),
  ]);

  await Promise.all(
    inactiveAgents.map((agent) => removeAgentScheduler(agent.id)),
  );
  await Promise.all(activeAgents.map((agent) => registerAgentScheduler(agent)));

  return activeAgents.length;
}

export const syncActiveAgentSchedules = syncActiveAgentSchedulers;

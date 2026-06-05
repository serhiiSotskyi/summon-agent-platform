import type { Agent, TriggerType } from "@prisma/client";
import { getDb } from "@/lib/db";
import {
  getAgentRunQueue,
  SCHEDULED_TRIGGER_JOB_NAME,
  type ScheduledAgentTriggerJob,
} from "@/lib/queue/agent-runs";
import {
  getAgentSchedulerId,
  readScheduleConfig,
  withAgentSchedulerId,
} from "./schedules";

type SchedulableAgent = Pick<
  Agent,
  "id" | "workspaceId" | "triggerType" | "triggerConfig" | "status"
>;

function shouldHaveScheduler(agent: SchedulableAgent) {
  return agent.status === "ACTIVE" && agent.triggerType === "SCHEDULED";
}

export async function registerAgentScheduler(agent: SchedulableAgent) {
  const queue = getAgentRunQueue();
  const schedulerId = getAgentSchedulerId(agent.id);

  if (!shouldHaveScheduler(agent)) {
    await queue.removeJobScheduler(schedulerId);
    return false;
  }

  const schedule = readScheduleConfig(agent.triggerConfig);
  if (!schedule) {
    await queue.removeJobScheduler(schedulerId);
    return false;
  }

  const scheduleWithId = withAgentSchedulerId(schedule, agent.id);
  const data: ScheduledAgentTriggerJob = {
    kind: "scheduled-trigger",
    agentId: agent.id,
    workspaceId: agent.workspaceId,
  };

  await queue.upsertJobScheduler(
    scheduleWithId.jobSchedulerId ?? schedulerId,
    {
      pattern: scheduleWithId.pattern,
      tz: scheduleWithId.timezone,
    },
    {
      name: SCHEDULED_TRIGGER_JOB_NAME,
      data,
      opts: {
        removeOnComplete: {
          age: 60 * 60 * 24 * 30,
        },
        removeOnFail: false,
      },
    },
  );

  return true;
}

export async function removeAgentScheduler(agentId: string) {
  return getAgentRunQueue().removeJobScheduler(getAgentSchedulerId(agentId));
}

export async function syncActiveAgentSchedulers() {
  const queue = getAgentRunQueue();
  const agents = await getDb().agent.findMany({
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
  });
  const activeSchedulerIds = new Set(agents.map((agent) => getAgentSchedulerId(agent.id)));

  await Promise.all(agents.map((agent) => registerAgentScheduler(agent)));

  const schedulers = await queue.getJobSchedulers();
  await Promise.all(
    schedulers
      .filter(
        (scheduler) =>
          scheduler.key.startsWith("agent:") && !activeSchedulerIds.has(scheduler.key),
      )
      .map((scheduler) => queue.removeJobScheduler(scheduler.key)),
  );

  return agents.length;
}

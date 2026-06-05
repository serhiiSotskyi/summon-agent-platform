import { createHash } from "node:crypto";
import PgBoss from "pg-boss";
import { getEnv, requireEnv } from "@/lib/env";

export const AGENT_RUN_QUEUE_NAME = "agent-runs";
export const SCHEDULED_TRIGGER_QUEUE_NAME = "agent-scheduled-triggers";
export const APPROVED_ACTION_QUEUE_NAME = "agent-approved-actions";

export type ManualAgentRunJob = {
  kind?: "manual-run";
  agentId: string;
  agentRunId: string;
  workspaceId: string;
  triggeredById?: string;
};

export type ScheduledAgentTriggerJob = {
  kind: "scheduled-trigger";
  agentId: string;
  workspaceId: string;
};

export type ApprovedActionJob = {
  kind: "approved-action";
  approvalRequestId: string;
  workspaceId: string;
  reviewedById: string;
  agentRunId?: string | null;
};

export type AgentRunJob =
  | ManualAgentRunJob
  | ScheduledAgentTriggerJob
  | ApprovedActionJob;

type BossInstance = PgBoss;

const globalForBoss = globalThis as unknown as {
  agentRunBoss?: BossInstance;
  agentRunBossStart?: Promise<BossInstance>;
  agentRunQueuesReady?: Promise<void>;
};

function getQueueDatabaseUrl() {
  return getEnv("PG_BOSS_DATABASE_URL") ?? requireEnv("DATABASE_URL");
}

function createBoss() {
  const boss = new PgBoss({
    connectionString: getQueueDatabaseUrl(),
    application_name: "summon-agent-platform-queue",
    schema: "pgboss",
    schedule: false,
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    expireInMinutes: 15,
    retentionDays: 30,
    deleteAfterDays: 30,
  });

  boss.on("error", (error) => {
    console.error(`[agent-runs] pg-boss error: ${error.message}`);
  });

  return boss;
}

export async function getAgentRunBoss() {
  if (!globalForBoss.agentRunBoss) {
    globalForBoss.agentRunBoss = createBoss();
  }

  if (!globalForBoss.agentRunBossStart) {
    globalForBoss.agentRunBossStart = globalForBoss.agentRunBoss.start();
  }

  return globalForBoss.agentRunBossStart;
}

export async function ensureAgentRunQueues() {
  if (!globalForBoss.agentRunQueuesReady) {
    globalForBoss.agentRunQueuesReady = (async () => {
      const boss = await getAgentRunBoss();
      await Promise.all([
        boss.createQueue(AGENT_RUN_QUEUE_NAME, {
          name: AGENT_RUN_QUEUE_NAME,
          retryLimit: 2,
          retryDelay: 10,
          retryBackoff: true,
          expireInMinutes: 15,
          retentionMinutes: 60 * 24 * 30,
        }),
        boss.createQueue(SCHEDULED_TRIGGER_QUEUE_NAME, {
          name: SCHEDULED_TRIGGER_QUEUE_NAME,
          retryLimit: 1,
          retryDelay: 30,
          retryBackoff: true,
          expireInMinutes: 15,
          retentionMinutes: 60 * 24 * 30,
        }),
        boss.createQueue(APPROVED_ACTION_QUEUE_NAME, {
          name: APPROVED_ACTION_QUEUE_NAME,
          retryLimit: 2,
          retryDelay: 10,
          retryBackoff: true,
          expireInMinutes: 15,
          retentionMinutes: 60 * 24 * 30,
        }),
      ]);
    })();
  }

  return globalForBoss.agentRunQueuesReady;
}

function stableUuid(input: string) {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 32);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export function getAgentSchedulerJobId(agentId: string) {
  return stableUuid(`agent-schedule:${agentId}`);
}

export async function enqueueManualRun(job: ManualAgentRunJob) {
  await ensureAgentRunQueues();
  const boss = await getAgentRunBoss();

  return boss.send(
    AGENT_RUN_QUEUE_NAME,
    {
      ...job,
      kind: "manual-run",
    },
    {
      retryLimit: 2,
      retryDelay: 10,
      retryBackoff: true,
      retentionDays: 30,
    },
  );
}

export async function enqueueScheduledTrigger(
  job: ScheduledAgentTriggerJob,
  startAfter: Date,
) {
  await ensureAgentRunQueues();
  const boss = await getAgentRunBoss();
  const jobId = getAgentSchedulerJobId(job.agentId);

  await boss.deleteJob(SCHEDULED_TRIGGER_QUEUE_NAME, jobId).catch(() => undefined);

  return boss.send(
    SCHEDULED_TRIGGER_QUEUE_NAME,
    job,
    {
      id: jobId,
      startAfter,
      retryLimit: 1,
      retryDelay: 30,
      retryBackoff: true,
      retentionDays: 30,
    },
  );
}

export async function removeScheduledTrigger(agentId: string) {
  await ensureAgentRunQueues();
  const boss = await getAgentRunBoss();

  await boss
    .deleteJob(SCHEDULED_TRIGGER_QUEUE_NAME, getAgentSchedulerJobId(agentId))
    .catch(() => undefined);
}

export async function enqueueApprovedAction(job: ApprovedActionJob) {
  await ensureAgentRunQueues();
  const boss = await getAgentRunBoss();

  return boss.send(
    APPROVED_ACTION_QUEUE_NAME,
    job,
    {
      retryLimit: 2,
      retryDelay: 10,
      retryBackoff: true,
      retentionDays: 30,
    },
  );
}

export async function stopAgentRunBoss() {
  if (!globalForBoss.agentRunBoss) {
    return;
  }

  await globalForBoss.agentRunBoss.stop({ graceful: true, wait: true });
  globalForBoss.agentRunBoss = undefined;
  globalForBoss.agentRunBossStart = undefined;
  globalForBoss.agentRunQueuesReady = undefined;
}

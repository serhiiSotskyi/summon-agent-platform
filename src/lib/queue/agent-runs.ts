import { Queue } from "bullmq";
import { requireEnv } from "@/lib/env";

export const AGENT_RUN_QUEUE_NAME = "agent-runs-v2";
export const MANUAL_RUN_JOB_NAME = "manual-run";
export const SCHEDULED_TRIGGER_JOB_NAME = "scheduled-trigger";

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

export type AgentRunJob = ManualAgentRunJob | ScheduledAgentTriggerJob;

function createAgentRunQueue() {
  return new Queue<AgentRunJob>(AGENT_RUN_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 10_000,
      },
      removeOnComplete: {
        age: 60 * 60 * 24 * 30,
      },
      removeOnFail: false,
    },
  });
}

type AgentRunQueue = ReturnType<typeof createAgentRunQueue>;

const globalForQueues = globalThis as unknown as {
  agentRunQueue?: AgentRunQueue;
};

export function getRedisConnectionOptions() {
  const redisUrl = new URL(requireEnv("REDIS_URL"));
  const isTls = redisUrl.protocol === "rediss:";

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || (isTls ? 6380 : 6379)),
    username: redisUrl.username
      ? decodeURIComponent(redisUrl.username)
      : undefined,
    password: redisUrl.password
      ? decodeURIComponent(redisUrl.password)
      : undefined,
    tls: isTls ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export function getAgentRunQueue() {
  if (!globalForQueues.agentRunQueue) {
    globalForQueues.agentRunQueue = createAgentRunQueue();
  }

  return globalForQueues.agentRunQueue;
}

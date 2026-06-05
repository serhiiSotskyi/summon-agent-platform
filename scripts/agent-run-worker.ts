import { Worker } from "bullmq";
import {
  createScheduledAgentRun,
  executeAgentRun,
} from "../src/lib/agents/runs";
import { syncActiveAgentSchedulers } from "../src/lib/agents/scheduler";
import {
  AGENT_RUN_QUEUE_NAME,
  MANUAL_RUN_JOB_NAME,
  SCHEDULED_TRIGGER_JOB_NAME,
  getRedisConnectionOptions,
  type AgentRunJob,
} from "../src/lib/queue/agent-runs";

async function processJob(job: { id?: string | number; name: string; data: AgentRunJob }) {
  if (job.name === SCHEDULED_TRIGGER_JOB_NAME || job.data.kind === "scheduled-trigger") {
    console.log(`[agent-runs] scheduled trigger ${job.id ?? "unknown"} for agent ${job.data.agentId}`);
    const run = await createScheduledAgentRun({
      agentId: job.data.agentId,
      workspaceId: job.data.workspaceId,
    });

    if (!run) {
      console.log(
        `[agent-runs] skipped scheduled trigger ${job.id ?? "unknown"} for agent ${job.data.agentId}`,
      );
      return null;
    }

    return executeAgentRun({
      kind: "manual-run",
      agentId: run.agentId,
      agentRunId: run.id,
      workspaceId: job.data.workspaceId,
    });
  }

  return executeAgentRun(job.data);
}

const worker = new Worker<AgentRunJob>(
  AGENT_RUN_QUEUE_NAME,
  async (job) => {
    const label =
      job.name === MANUAL_RUN_JOB_NAME && "agentRunId" in job.data
        ? `run ${job.data.agentRunId}`
        : `agent ${job.data.agentId}`;
    console.log(`[agent-runs] starting ${job.id} for ${label}`);
    const run = await processJob(job);

    if (run) {
      console.log(`[agent-runs] finished ${job.id} for run ${run.id} with ${run.status}`);
    }
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: 2,
  },
);

worker.on("failed", (job, error) => {
  console.error(
    `[agent-runs] failed ${job?.id ?? "unknown"} for agent ${job?.data.agentId ?? "unknown"}: ${error.message}`,
  );
});

worker.on("error", (error) => {
  console.error(`[agent-runs] worker error: ${error.message}`);
});

async function shutdown(signal: string) {
  console.log(`[agent-runs] received ${signal}, shutting down`);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

syncActiveAgentSchedulers()
  .then((count) => {
    console.log(`[agent-runs] synced ${count} active scheduled agent${count === 1 ? "" : "s"}`);
  })
  .catch((error: Error) => {
    console.error(`[agent-runs] scheduler sync failed: ${error.message}`);
  })
  .finally(() => {
    console.log(
      `[agent-runs] worker ready (queue=${AGENT_RUN_QUEUE_NAME}, mode=read-only, pid=${process.pid})`,
    );
  });

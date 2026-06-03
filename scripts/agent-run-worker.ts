import { Worker } from "bullmq";
import { executeAgentRun } from "../src/lib/agents/runs";
import {
  AGENT_RUN_QUEUE_NAME,
  getRedisConnectionOptions,
  type AgentRunJob,
} from "../src/lib/queue/agent-runs";

const worker = new Worker<AgentRunJob>(
  AGENT_RUN_QUEUE_NAME,
  async (job) => {
    console.log(`[agent-runs] starting ${job.id} for run ${job.data.agentRunId}`);
    const run = await executeAgentRun(job.data);
    console.log(
      `[agent-runs] finished ${job.id} for run ${job.data.agentRunId} with ${run.status}`,
    );
  },
  {
    connection: getRedisConnectionOptions(),
    concurrency: 2,
  },
);

worker.on("failed", (job, error) => {
  console.error(
    `[agent-runs] failed ${job?.id ?? "unknown"} for run ${job?.data.agentRunId ?? "unknown"}: ${error.message}`,
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

console.log(
  `[agent-runs] worker ready (queue=${AGENT_RUN_QUEUE_NAME}, mode=read-only, pid=${process.pid})`,
);

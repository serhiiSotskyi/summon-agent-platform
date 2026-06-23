import type PgBoss from "pg-boss";
import {
  createScheduledAgentRun,
  executeAgentRun,
  executeApprovedAction,
  markStaleAgentRunsFailed,
} from "../src/lib/agents/runs";
import {
  registerAgentScheduler,
  syncActiveAgentSchedulers,
} from "../src/lib/agents/scheduler";
import { getDb } from "../src/lib/db";
import {
  AGENT_RUN_QUEUE_NAME,
  APPROVED_ACTION_QUEUE_NAME,
  SCHEDULED_TRIGGER_QUEUE_NAME,
  ensureAgentRunQueues,
  getAgentRunBoss,
  stopAgentRunBoss,
  type ApprovedActionJob,
  type ManualAgentRunJob,
  type ScheduledAgentTriggerJob,
} from "../src/lib/queue/agent-runs";

async function processManualRun(job: PgBoss.Job<ManualAgentRunJob>) {
  const runId = job.data.agentRunId;
  console.log(`[agent-runs] starting ${job.id} for run ${runId}`);
  const run = await executeAgentRun(job.data);
  console.log(`[agent-runs] finished ${job.id} for run ${run.id} with ${run.status}`);
}

async function rescheduleAgent(agentId: string) {
  const agent = await getDb().agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      workspaceId: true,
      triggerType: true,
      triggerConfig: true,
      status: true,
    },
  });

  if (agent) {
    await registerAgentScheduler(agent);
  }
}

async function processScheduledTrigger(job: PgBoss.Job<ScheduledAgentTriggerJob>) {
  console.log(`[agent-runs] scheduled trigger ${job.id} for agent ${job.data.agentId}`);

  try {
    const run = await createScheduledAgentRun({
      agentId: job.data.agentId,
      workspaceId: job.data.workspaceId,
    });

    if (!run) {
      console.log(`[agent-runs] skipped scheduled trigger ${job.id} for agent ${job.data.agentId}`);
      return;
    }

    const result = await executeAgentRun({
      kind: "manual-run",
      agentId: run.agentId,
      agentRunId: run.id,
      workspaceId: job.data.workspaceId,
    });
    console.log(`[agent-runs] finished scheduled trigger ${job.id} for run ${result.id} with ${result.status}`);
  } finally {
    await rescheduleAgent(job.data.agentId);
  }
}

async function processApprovedAction(job: PgBoss.Job<ApprovedActionJob>) {
  console.log(`[agent-runs] executing approved action ${job.id} for approval ${job.data.approvalRequestId}`);
  await executeApprovedAction(job.data);
  console.log(`[agent-runs] finished approved action ${job.id} for approval ${job.data.approvalRequestId}`);
}

async function registerWorkers(boss: PgBoss) {
  await Promise.all([
    boss.work<ManualAgentRunJob>(
      AGENT_RUN_QUEUE_NAME,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) {
          await processManualRun(job);
        }
      },
    ),
    boss.work<ScheduledAgentTriggerJob>(
      SCHEDULED_TRIGGER_QUEUE_NAME,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) {
          await processScheduledTrigger(job);
        }
      },
    ),
    boss.work<ApprovedActionJob>(
      APPROVED_ACTION_QUEUE_NAME,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) {
          await processApprovedAction(job);
        }
      },
    ),
  ]);
}

let staleRunSweepInterval: ReturnType<typeof setInterval> | undefined;

async function sweepStaleRuns() {
  const failedCount = await markStaleAgentRunsFailed();
  if (failedCount > 0) {
    console.log(`[agent-runs] marked ${failedCount} stale zero-tool run${failedCount === 1 ? "" : "s"} as failed`);
  }
}

async function shutdown(signal: string) {
  console.log(`[agent-runs] received ${signal}, shutting down`);
  if (staleRunSweepInterval) {
    clearInterval(staleRunSweepInterval);
  }
  await stopAgentRunBoss();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main() {
  const boss = await getAgentRunBoss();
  await ensureAgentRunQueues();
  await registerWorkers(boss);
  await sweepStaleRuns();
  staleRunSweepInterval = setInterval(() => {
    void sweepStaleRuns().catch((error: Error) => {
      console.error(`[agent-runs] stale run sweep failed: ${error.message}`);
    });
  }, 60_000);
  const count = await syncActiveAgentSchedulers();

  console.log(`[agent-runs] synced ${count} active scheduled agent${count === 1 ? "" : "s"}`);
  console.log(
    `[agent-runs] worker ready (queue=${AGENT_RUN_QUEUE_NAME}, backend=pg-boss, mode=tool-loop, pid=${process.pid})`,
  );
}

main().catch((error: Error) => {
  console.error(`[agent-runs] worker startup failed: ${error.message}`);
  process.exit(1);
});

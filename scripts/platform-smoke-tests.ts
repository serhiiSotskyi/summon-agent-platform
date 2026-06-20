import assert from "node:assert/strict";
import {
  buildScheduleConfig,
  DEFAULT_SCHEDULE_TIMEZONE,
  formatScheduleSummary,
  readScheduleConfig,
  withAgentSchedulerId,
} from "../src/lib/agents/schedules";
import { SUMMON_MEMORY_SYSTEM_INSTRUCTION } from "../src/lib/agents/defaults";
import { getUploadedFilesFromFormData } from "../src/lib/agents/files";
import { estimateLlmCost, getPricingMetadata } from "../src/lib/llm/pricing";
import { GENERIC_AGENT_TOOLS } from "../src/lib/tools/definitions";

function testSchedules() {
  const daily = buildScheduleConfig({
    frequency: "DAILY",
    timeOfDay: "08:30",
    timezone: "Europe/London",
    agentId: "agent_123",
  });

  assert.equal(daily.pattern, "30 8 * * *");
  assert.equal(daily.timezone, "Europe/London");
  assert.equal(daily.jobSchedulerId, "agent:agent_123");
  assert.equal(formatScheduleSummary(daily), "Daily at 08:30 (Europe/London)");

  const weekly = buildScheduleConfig({
    frequency: "WEEKLY",
    timeOfDay: "25:90",
    timezone: "Not/AZone",
    weekday: 9,
  });

  assert.equal(weekly.pattern, "59 23 * * 6");
  assert.equal(weekly.timezone, DEFAULT_SCHEDULE_TIMEZONE);
  assert.equal(formatScheduleSummary(weekly), "Weekly on Saturday at 23:59 (Europe/London)");

  const hourly = buildScheduleConfig({ frequency: "HOURLY", minute: -4 });
  assert.equal(hourly.pattern, "0 * * * *");
  assert.equal(formatScheduleSummary(hourly), "Hourly at minute 00 (Europe/London)");

  const restored = readScheduleConfig(withAgentSchedulerId(daily, "agent_456"));
  assert.equal(restored?.jobSchedulerId, "agent:agent_456");
  assert.equal(restored?.pattern, "30 8 * * *");
}

function testPricing() {
  const usage = {
    inputTokens: 1_000,
    outputTokens: 500,
    totalTokens: 1_500,
  };
  const cost = estimateLlmCost({ provider: "openai", model: "gpt-4.1", usage });

  assert.equal(cost, 0.006);
  assert.deepEqual(
    getPricingMetadata({
      provider: "openai",
      model: "gpt-4.1",
      usage,
      estimatedCostUsd: cost,
    }),
    {
      status: "estimated",
      provider: "openai",
      model: "gpt-4.1",
      usage,
      estimatedCostUsd: 0.006,
      pricingVersion: "2026-06-08",
    },
  );

  assert.equal(
    estimateLlmCost({
      provider: "openai",
      model: "unknown-model",
      usage,
    }),
    null,
  );
}

function testMemoryInstruction() {
  const instruction = SUMMON_MEMORY_SYSTEM_INSTRUCTION.toLowerCase();

  assert.match(instruction, /notion/);
  assert.match(instruction, /google drive/);
  assert.match(instruction, /budget trackers/);
  assert.match(instruction, /google ads/);
  assert.match(instruction, /cite evidence/);
  assert.match(instruction, /not found|unverified/);
  assert.match(instruction, /approval/);
}

function testRoleGroupedUploads() {
  const formData = new FormData();
  formData.append(
    "agentFiles:input_data",
    new File(["campaign,spend\nBrand,120"], "report.csv", {
      type: "text/csv",
    }),
  );
  formData.append(
    "agentFiles:helper_code",
    new File(["print('ok')"], "metrics.py", {
      type: "text/x-python",
    }),
  );
  formData.append(
    "agentFiles:reference",
    new File(["notes"], "brief.md", {
      type: "text/markdown",
    }),
  );

  const files = getUploadedFilesFromFormData(formData);

  assert.deepEqual(
    files.map((file) => [file.file.name, file.role]),
    [
      ["report.csv", "input_data"],
      ["metrics.py", "helper_code"],
      ["brief.md", "reference"],
    ],
  );
}

function testToolPolicyMetadata() {
  assert.ok(GENERIC_AGENT_TOOLS.length > 0);

  for (const tool of GENERIC_AGENT_TOOLS) {
    assert.ok(tool.authRequirement, `${tool.key} is missing authRequirement`);
    assert.ok(tool.approvalPolicy, `${tool.key} is missing approvalPolicy`);
    assert.ok(tool.retryPolicy, `${tool.key} is missing retryPolicy`);
    assert.ok(tool.timeoutMs > 0, `${tool.key} is missing timeoutMs`);
  }

  const slideWriter = GENERIC_AGENT_TOOLS.find(
    (tool) => tool.key === "google.slides.batchUpdate",
  );
  assert.equal(slideWriter?.riskLevel, "run_owned_write");
  assert.match(slideWriter?.approvalPolicy ?? "", /run-owned/i);
}

testSchedules();
testPricing();
testMemoryInstruction();
testRoleGroupedUploads();
testToolPolicyMetadata();

console.log("platform smoke tests passed");

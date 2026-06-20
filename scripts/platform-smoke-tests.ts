import assert from "node:assert/strict";
import {
  buildScheduleConfig,
  DEFAULT_SCHEDULE_TIMEZONE,
  formatScheduleSummary,
  readScheduleConfig,
  withAgentSchedulerId,
} from "../src/lib/agents/schedules";
import { SUMMON_MEMORY_SYSTEM_INSTRUCTION } from "../src/lib/agents/defaults";
import { estimateLlmCost, getPricingMetadata } from "../src/lib/llm/pricing";

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

testSchedules();
testPricing();
testMemoryInstruction();

console.log("platform smoke tests passed");

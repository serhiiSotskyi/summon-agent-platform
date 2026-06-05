import type { Prisma } from "@prisma/client";

export const DEFAULT_SCHEDULE_TIMEZONE = "Europe/London";

export const SCHEDULE_FREQUENCIES = ["HOURLY", "DAILY", "WEEKLY"] as const;

export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export type ScheduleConfigV1 = {
  version: 1;
  frequency: ScheduleFrequency;
  timezone: string;
  pattern: string;
  jobSchedulerId?: string;
  minute?: number;
  timeOfDay?: string;
  weekday?: number;
};

export type BuildScheduleInput = {
  frequency: string;
  timezone?: string;
  minute?: string | number;
  timeOfDay?: string;
  weekday?: string | number;
  agentId?: string;
};

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function parseInteger(value: string | number | undefined, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTimezone(value: string | undefined) {
  const timezone = value?.trim() || DEFAULT_SCHEDULE_TIMEZONE;

  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_SCHEDULE_TIMEZONE;
  }
}

function parseTimeOfDay(value: string | undefined) {
  const match = value?.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hours: 9, minutes: 0, value: "09:00" };
  }

  const hours = clamp(Number(match[1]), 0, 23);
  const minutes = clamp(Number(match[2]), 0, 59);

  return {
    hours,
    minutes,
    value: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
  };
}

export function getAgentSchedulerId(agentId: string) {
  return `agent:${agentId}`;
}

export function buildScheduleConfig(input: BuildScheduleInput): ScheduleConfigV1 {
  const frequency = SCHEDULE_FREQUENCIES.includes(input.frequency as ScheduleFrequency)
    ? (input.frequency as ScheduleFrequency)
    : "DAILY";
  const timezone = normalizeTimezone(input.timezone);
  const jobSchedulerId = input.agentId ? getAgentSchedulerId(input.agentId) : undefined;

  if (frequency === "HOURLY") {
    const minute = clamp(parseInteger(input.minute, 0), 0, 59);

    return {
      version: 1,
      frequency,
      timezone,
      minute,
      pattern: `${minute} * * * *`,
      jobSchedulerId,
    };
  }

  const time = parseTimeOfDay(input.timeOfDay);

  if (frequency === "WEEKLY") {
    const weekday = clamp(parseInteger(input.weekday, 1), 0, 6);

    return {
      version: 1,
      frequency,
      timezone,
      timeOfDay: time.value,
      weekday,
      pattern: `${time.minutes} ${time.hours} * * ${weekday}`,
      jobSchedulerId,
    };
  }

  return {
    version: 1,
    frequency,
    timezone,
    timeOfDay: time.value,
    pattern: `${time.minutes} ${time.hours} * * *`,
    jobSchedulerId,
  };
}

export function withAgentSchedulerId(
  schedule: ScheduleConfigV1,
  agentId: string,
): ScheduleConfigV1 {
  return {
    ...schedule,
    jobSchedulerId: getAgentSchedulerId(agentId),
  };
}

export function readScheduleConfig(
  value: Prisma.JsonValue | Prisma.InputJsonValue | null | undefined,
): ScheduleConfigV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }

  const frequency = record.frequency;
  const timezone = record.timezone;

  if (
    typeof frequency !== "string" ||
    !SCHEDULE_FREQUENCIES.includes(frequency as ScheduleFrequency) ||
    typeof timezone !== "string"
  ) {
    return null;
  }

  const normalized = buildScheduleConfig({
    frequency,
    timezone,
    minute: typeof record.minute === "number" ? record.minute : undefined,
    timeOfDay:
      typeof record.timeOfDay === "string" ? record.timeOfDay : undefined,
    weekday: typeof record.weekday === "number" ? record.weekday : undefined,
  });

  return {
    ...normalized,
    jobSchedulerId:
      typeof record.jobSchedulerId === "string" ? record.jobSchedulerId : undefined,
  };
}

export function formatScheduleSummary(schedule: ScheduleConfigV1 | null) {
  if (!schedule) {
    return "No schedule configured";
  }

  if (schedule.frequency === "HOURLY") {
    return `Hourly at minute ${String(schedule.minute ?? 0).padStart(2, "0")} (${schedule.timezone})`;
  }

  if (schedule.frequency === "WEEKLY") {
    return `Weekly on ${WEEKDAY_LABELS[schedule.weekday ?? 1]} at ${schedule.timeOfDay ?? "09:00"} (${schedule.timezone})`;
  }

  return `Daily at ${schedule.timeOfDay ?? "09:00"} (${schedule.timezone})`;
}

function getZonedParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      parts.weekday,
    ),
  };
}

function getTimezoneOffsetMs(date: Date, timezone: string) {
  const parts = getZonedParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
}

function zonedTimeToDate({
  year,
  month,
  day,
  hour,
  minute,
  timezone,
}: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = new Date(utcGuess - getTimezoneOffsetMs(new Date(utcGuess), timezone));
  const secondPass = new Date(
    utcGuess - getTimezoneOffsetMs(firstPass, timezone),
  );

  return secondPass;
}

function addDays(parts: ReturnType<typeof getZonedParts>, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function getNextScheduleDate(
  schedule: ScheduleConfigV1 | null,
  from = new Date(),
) {
  if (!schedule) {
    return null;
  }

  const now = getZonedParts(from, schedule.timezone);

  if (schedule.frequency === "HOURLY") {
    const minute = schedule.minute ?? 0;
    const shouldAdvanceHour =
      now.minute > minute || (now.minute === minute && now.second > 0);
    const localCandidate = new Date(
      Date.UTC(
        now.year,
        now.month - 1,
        now.day,
        now.hour + (shouldAdvanceHour ? 1 : 0),
        minute,
        0,
      ),
    );
    const candidateParts = getZonedParts(localCandidate, "UTC");

    return zonedTimeToDate({
      ...candidateParts,
      timezone: schedule.timezone,
    });
  }

  const [hourRaw, minuteRaw] = (schedule.timeOfDay ?? "09:00").split(":");
  const targetHour = Number(hourRaw);
  const targetMinute = Number(minuteRaw);
  let daysToAdd = 0;

  if (
    now.hour > targetHour ||
    (now.hour === targetHour && now.minute >= targetMinute)
  ) {
    daysToAdd = 1;
  }

  if (schedule.frequency === "WEEKLY") {
    const targetWeekday = schedule.weekday ?? 1;
    daysToAdd = (targetWeekday - now.weekday + 7) % 7;
    if (
      daysToAdd === 0 &&
      (now.hour > targetHour ||
        (now.hour === targetHour && now.minute >= targetMinute))
    ) {
      daysToAdd = 7;
    }
  }

  const nextDay = addDays(now, daysToAdd);
  return zonedTimeToDate({
    ...nextDay,
    hour: targetHour,
    minute: targetMinute,
    timezone: schedule.timezone,
  });
}

"use client";

import { useMemo, useState } from "react";
import { Input, Label, Select } from "@/components/ui/form";
import {
  buildScheduleConfig,
  DEFAULT_SCHEDULE_TIMEZONE,
  formatScheduleSummary,
  getNextScheduleDate,
  type ScheduleFrequency,
} from "@/lib/agents/schedules";

const WEEKDAYS = [
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
  ["0", "Sunday"],
] as const;

const COMMON_TIMEZONES = [
  ["Europe/London", "London"],
  ["Europe/Istanbul", "Istanbul"],
  ["UTC", "UTC"],
  ["America/New_York", "New York"],
  ["America/Los_Angeles", "Los Angeles"],
  ["Asia/Dubai", "Dubai"],
  ["Asia/Singapore", "Singapore"],
  ["Australia/Sydney", "Sydney"],
] as const;

function formatDateInTimezone(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function ScheduleFields({
  defaultFrequency = "DAILY",
  defaultMinute = 0,
  defaultTimeOfDay = "09:00",
  defaultTimezone = DEFAULT_SCHEDULE_TIMEZONE,
  defaultWeekday = 1,
}: {
  defaultFrequency?: ScheduleFrequency;
  defaultMinute?: number;
  defaultTimeOfDay?: string;
  defaultTimezone?: string;
  defaultWeekday?: number;
}) {
  const [frequency, setFrequency] =
    useState<ScheduleFrequency>(defaultFrequency);
  const [minute, setMinute] = useState(String(defaultMinute));
  const [timeOfDay, setTimeOfDay] = useState(defaultTimeOfDay);
  const [weekday, setWeekday] = useState(String(defaultWeekday));
  const [timezone, setTimezone] = useState(defaultTimezone);

  const browserTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;

  const preview = useMemo(() => {
    const schedule = buildScheduleConfig({
      frequency,
      minute,
      timeOfDay,
      timezone,
      weekday,
    });
    const nextRun = getNextScheduleDate(schedule);

    return {
      nextRun,
      summary: formatScheduleSummary(schedule),
    };
  }, [frequency, minute, timeOfDay, timezone, weekday]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="scheduleFrequency">Frequency</Label>
          <Select
            id="scheduleFrequency"
            name="scheduleFrequency"
            onChange={(event) =>
              setFrequency(event.currentTarget.value as ScheduleFrequency)
            }
            value={frequency}
          >
            <option value="HOURLY">Hourly</option>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
          </Select>
        </div>

        {frequency === "HOURLY" ? (
          <div className="space-y-2">
            <Label htmlFor="scheduleMinute">Minute past each hour</Label>
            <Input
              id="scheduleMinute"
              max="59"
              min="0"
              name="scheduleMinute"
              onChange={(event) => setMinute(event.currentTarget.value)}
              type="number"
              value={minute}
            />
          </div>
        ) : null}

        {frequency !== "HOURLY" ? (
          <div className="space-y-2">
            <Label htmlFor="scheduleTimeOfDay">Time of day</Label>
            <Input
              id="scheduleTimeOfDay"
              name="scheduleTimeOfDay"
              onChange={(event) => setTimeOfDay(event.currentTarget.value)}
              type="time"
              value={timeOfDay}
            />
          </div>
        ) : (
          <input name="scheduleTimeOfDay" type="hidden" value={timeOfDay} />
        )}

        {frequency === "WEEKLY" ? (
          <div className="space-y-2">
            <Label htmlFor="scheduleWeekday">Weekday</Label>
            <Select
              id="scheduleWeekday"
              name="scheduleWeekday"
              onChange={(event) => setWeekday(event.currentTarget.value)}
              value={weekday}
            >
              {WEEKDAYS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <input name="scheduleWeekday" type="hidden" value={weekday} />
        )}

        {frequency !== "HOURLY" ? (
          <input name="scheduleMinute" type="hidden" value={minute} />
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="space-y-2">
          <Label htmlFor="scheduleTimezone">Timezone used for scheduling</Label>
          <Select
            id="scheduleTimezone"
            name="scheduleTimezone"
            onChange={(event) => setTimezone(event.currentTarget.value)}
            value={timezone}
          >
            {COMMON_TIMEZONES.map(([value, label]) => (
              <option key={value} value={value}>
                {label} ({value})
              </option>
            ))}
          </Select>
        </div>

        <div className="rounded-md border border-emerald-300/15 bg-emerald-300/5 p-3 text-sm leading-6 text-zinc-300">
          <p className="font-medium text-emerald-100">{preview.summary}</p>
          {frequency === "HOURLY" ? (
            <p className="mt-1 text-zinc-500">
              Example: minute 15 runs at 09:15, 10:15, 11:15, and so on.
            </p>
          ) : null}
          {preview.nextRun ? (
            <p className="mt-1 text-zinc-400">
              Next run: {formatDateInTimezone(preview.nextRun, timezone)}{" "}
              {timezone}
              {browserTimezone !== timezone
                ? ` / ${formatDateInTimezone(preview.nextRun, browserTimezone)} ${browserTimezone}`
                : ""}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

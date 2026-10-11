import { describe, expect, it } from "vitest";

import type { BriefingDefinition } from "@moss/db";
import { DEFAULT_LOCALE_SETTINGS } from "@moss/shared";

import { BRIEFINGS_RUN_QUEUE } from "../../packages/briefings/src/manifest.js";
import {
  alignScheduledFire,
  cronExprFor,
  defaultScheduleMetadataFor,
  reconcileOwnedSchedules,
  reconcileSchedule,
  timezoneFor
} from "../../packages/briefings/src/schedule.js";

describe("cronExprFor", () => {
  it("maps a HH:MM targetTime to a daily cron expression", () => {
    expect(cronExprFor("daily", { targetTime: "06:00" })).toBe("0 6 * * *");
    expect(cronExprFor("daily", { targetTime: "23:45" })).toBe("45 23 * * *");
  });

  it("defaults to 07:00 when targetTime is absent", () => {
    expect(cronExprFor("daily", {})).toBe("0 7 * * *");
  });

  it("defaults to 07:00 when targetTime is malformed", () => {
    expect(cronExprFor("daily", { targetTime: "not-a-time" })).toBe("0 7 * * *");
    expect(cronExprFor("daily", { targetTime: "25:00" })).toBe("0 7 * * *");
    expect(cronExprFor("daily", { targetTime: "6" })).toBe("0 7 * * *");
  });

  it("emits a day-of-week cron for weekly cadence", () => {
    expect(cronExprFor("weekly", { targetTime: "09:00", dayOfWeek: 0 })).toBe("0 9 * * 0");
    expect(cronExprFor("weekly", { targetTime: "09:00", dayOfWeek: 5 })).toBe("0 9 * * 5");
    expect(cronExprFor("weekly", { targetTime: "09:00" })).toBe("0 9 * * 1");
  });
});

describe("timezoneFor", () => {
  it("returns a valid IANA timezone", () => {
    expect(timezoneFor({ timezone: "America/New_York" })).toBe("America/New_York");
  });

  it("defaults to UTC when absent or invalid", () => {
    expect(timezoneFor({})).toBe("UTC");
    expect(timezoneFor({ timezone: "Not/AZone" })).toBe("UTC");
    expect(timezoneFor({ timezone: 42 as unknown as string })).toBe("UTC");
  });
});

describe("defaultScheduleMetadataFor", () => {
  it("uses the owner's timezone (#3390)", () => {
    expect(defaultScheduleMetadataFor("morning", "America/Los_Angeles")).toEqual({
      targetTime: "07:00",
      timezone: "America/Los_Angeles"
    });
    expect(defaultScheduleMetadataFor("evening", "Europe/Paris")).toEqual({
      targetTime: "19:00",
      timezone: "Europe/Paris"
    });
    expect(defaultScheduleMetadataFor("weekly_review", "Asia/Tokyo")).toEqual({
      targetTime: "09:00",
      timezone: "Asia/Tokyo",
      dayOfWeek: 0
    });
  });

  it("falls back to the app's default locale timezone, never UTC (#3390)", () => {
    expect(defaultScheduleMetadataFor("morning")).toEqual({
      targetTime: "07:00",
      timezone: DEFAULT_LOCALE_SETTINGS.timezone
    });
    expect(DEFAULT_LOCALE_SETTINGS.timezone).not.toBe("UTC");
  });
});

interface ScheduleCall {
  readonly name: string;
  readonly cron: string;
  readonly data: Record<string, unknown>;
  readonly options: { tz?: string; key?: string };
}

function fakeBoss() {
  const scheduleCalls: ScheduleCall[] = [];
  const unscheduleCalls: Array<{ name: string; key: string }> = [];
  return {
    scheduleCalls,
    unscheduleCalls,
    boss: {
      async schedule(name: string, cron: string, data: unknown, options: unknown) {
        scheduleCalls.push({
          name,
          cron,
          data: data as Record<string, unknown>,
          options: options as { tz?: string; key?: string }
        });
      },
      async unschedule(name: string, key: string) {
        unscheduleCalls.push({ name, key });
      }
    }
  };
}

function definition(overrides: Partial<BriefingDefinition>): BriefingDefinition {
  return {
    id: "def-1",
    owner_user_id: "owner-1",
    title: "Morning",
    cadence: "daily",
    schedule_metadata: { targetTime: "06:00", timezone: "America/New_York" },
    enabled: true,
    briefing_type: "morning",
    selected_tool_names: ["tasks.listVisible"],
    last_run_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides
  } as BriefingDefinition;
}

describe("reconcileSchedule", () => {
  it("schedules a daily enabled definition keyed by id with tz and metadata-only data", async () => {
    const { boss, scheduleCalls, unscheduleCalls } = fakeBoss();
    await reconcileSchedule(boss as never, definition({}));
    expect(unscheduleCalls).toHaveLength(0);
    expect(scheduleCalls).toHaveLength(1);
    const call = scheduleCalls[0]!;
    expect(call.name).toBe(BRIEFINGS_RUN_QUEUE);
    expect(call.cron).toBe("0 6 * * *");
    expect(call.options).toEqual({ tz: "America/New_York", key: "def-1" });
    expect(call.data).toEqual({
      actorUserId: "owner-1",
      definitionId: "def-1",
      runKind: "scheduled",
      briefingType: "morning"
    });
  });

  it("schedules a weekly enabled definition with day-of-week cron", async () => {
    const { boss, scheduleCalls, unscheduleCalls } = fakeBoss();
    await reconcileSchedule(
      boss as never,
      definition({
        cadence: "weekly",
        schedule_metadata: { targetTime: "09:00", timezone: "America/New_York", dayOfWeek: 0 }
      })
    );
    expect(unscheduleCalls).toHaveLength(0);
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.cron).toBe("0 9 * * 0");
    expect(scheduleCalls[0]!.options).toEqual({ tz: "America/New_York", key: "def-1" });
  });

  it("schedules in the owner's timezone over the stored one (#3390)", async () => {
    const { boss, scheduleCalls } = fakeBoss();
    await reconcileSchedule(
      boss as never,
      definition({ schedule_metadata: { targetTime: "07:00", timezone: "UTC" } }),
      "America/Los_Angeles"
    );
    expect(scheduleCalls[0]!.cron).toBe("0 7 * * *");
    expect(scheduleCalls[0]!.options).toEqual({ tz: "America/Los_Angeles", key: "def-1" });
  });

  it("unschedules when cadence is manual", async () => {
    const { boss, scheduleCalls, unscheduleCalls } = fakeBoss();
    await reconcileSchedule(boss as never, definition({ cadence: "manual" }));
    expect(scheduleCalls).toHaveLength(0);
    expect(unscheduleCalls).toEqual([{ name: BRIEFINGS_RUN_QUEUE, key: "def-1" }]);
  });

  it("unschedules when disabled", async () => {
    const { boss, scheduleCalls, unscheduleCalls } = fakeBoss();
    await reconcileSchedule(boss as never, definition({ enabled: false }));
    expect(scheduleCalls).toHaveLength(0);
    expect(unscheduleCalls).toEqual([{ name: BRIEFINGS_RUN_QUEUE, key: "def-1" }]);
  });
});

describe("reconcileOwnedSchedules", () => {
  it("moves every owned briefing to the owner's timezone (#3390)", async () => {
    const { boss, scheduleCalls } = fakeBoss();
    const stored = { targetTime: "07:00", timezone: "UTC" };
    const repository = {
      listDefinitions: async () => [
        definition({ id: "def-1", schedule_metadata: stored }),
        definition({ id: "def-2", schedule_metadata: stored }),
        definition({ id: "def-shared", owner_user_id: "someone-else", schedule_metadata: stored })
      ]
    };
    await reconcileOwnedSchedules(
      boss as never,
      {} as never,
      repository as never,
      "owner-1",
      undefined,
      "America/Los_Angeles"
    );
    expect(scheduleCalls.map((call) => [call.options])).toEqual([
      [{ tz: "America/Los_Angeles", key: "def-1" }],
      [{ tz: "America/Los_Angeles", key: "def-2" }]
    ]);
  });
});

describe("alignScheduledFire (#3390)", () => {
  const LA = "America/Los_Angeles";

  function bossWithSchedule(registeredTimeZone: string | null) {
    const fake = fakeBoss();
    return {
      ...fake,
      boss: {
        ...fake.boss,
        async getSchedules(name: string, key: string) {
          return registeredTimeZone === null
            ? []
            : [{ name, key, cron: "0 7 * * *", timezone: registeredTimeZone }];
        }
      }
    };
  }

  const morning = definition({ schedule_metadata: { targetTime: "07:00", timezone: "UTC" } });

  it("runs an aligned fire and leaves the schedule alone", async () => {
    const { boss, scheduleCalls } = bossWithSchedule(LA);
    const result = await alignScheduledFire(
      boss as never,
      morning,
      LA,
      new Date("2026-12-01T15:00:00Z")
    );
    expect(result).toEqual({ realigned: false, run: true });
    expect(scheduleCalls).toHaveLength(0);
  });

  it("re-registers a UTC cron in the owner's zone and skips the 11 PM winter fire", async () => {
    const { boss, scheduleCalls } = bossWithSchedule("UTC");
    // 07:00 UTC on Dec 2 is 23:00 on Dec 1 in Los Angeles.
    const result = await alignScheduledFire(
      boss as never,
      morning,
      LA,
      new Date("2026-12-02T07:00:00Z")
    );
    expect(result).toEqual({ realigned: true, run: false });
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0]!.options).toMatchObject({ tz: LA, key: "def-1" });
    expect(scheduleCalls[0]!.cron).toBe("0 7 * * *");
  });

  it("skips an early misaligned fire, since the realigned cron fires later that day", async () => {
    const { boss } = bossWithSchedule("UTC");
    // 07:00 UTC in July is 00:00 in Los Angeles.
    const result = await alignScheduledFire(
      boss as never,
      morning,
      LA,
      new Date("2026-07-01T07:00:00Z")
    );
    expect(result).toEqual({ realigned: true, run: false });
  });

  it("still runs a misaligned fire that lands within three hours after the target", async () => {
    const { boss } = bossWithSchedule("UTC");
    // 07:00 UTC in July is 09:00 in Berlin.
    const result = await alignScheduledFire(
      boss as never,
      morning,
      "Europe/Berlin",
      new Date("2026-07-01T07:00:00Z")
    );
    expect(result).toEqual({ realigned: true, run: true });
  });

  it("skips a misaligned weekly fire on the wrong local weekday", async () => {
    const { boss } = bossWithSchedule("UTC");
    const weekly = definition({
      cadence: "weekly",
      briefing_type: "weekly_review",
      schedule_metadata: { targetTime: "09:00", timezone: "UTC", dayOfWeek: 0 }
    });
    // Sunday 09:00 UTC is Sunday 18:00 in Tokyo (late), and Sunday 01:00 in Los Angeles (early).
    const sunday = new Date("2026-07-05T09:00:00Z");
    expect(await alignScheduledFire(boss as never, weekly, "Asia/Tokyo", sunday)).toEqual({
      realigned: true,
      run: false
    });
    // Sunday 13:30 UTC is Sunday 09:30 in New York: right weekday, within the grace.
    expect(
      await alignScheduledFire(
        boss as never,
        weekly,
        "America/New_York",
        new Date("2026-07-05T13:30:00Z")
      )
    ).toEqual({ realigned: true, run: true });
  });

  it("runs when no schedule is registered", async () => {
    const { boss, scheduleCalls } = bossWithSchedule(null);
    expect(await alignScheduledFire(boss as never, morning, LA, new Date())).toEqual({
      realigned: false,
      run: true
    });
    expect(scheduleCalls).toHaveLength(0);
  });
});

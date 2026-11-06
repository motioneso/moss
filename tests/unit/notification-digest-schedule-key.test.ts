import { describe, expect, it } from "vitest";

import {
  DIGEST_COMPOSE_QUEUE,
  digestScheduleData,
  digestScheduleKey,
  reconcileDigestSchedule,
  type NotificationDigestScheduler
} from "@moss/notifications";

// pg-boss checks every schedule key with assertObjectName in its attorney.js.
// A key may hold letters, digits, underscore, hyphen, period and slash only.
// A colon fails that check, so scheduling throws and the digest cannot be switched on.
const PG_BOSS_KEY_PATTERN = /^[\w.\-/]+$/;

const USER_ID = "00000000-0000-4000-8000-000000000001";

function fakeScheduler() {
  const scheduled: unknown[][] = [];
  const unscheduled: unknown[][] = [];
  const boss: NotificationDigestScheduler = {
    schedule: async (...args: unknown[]) => {
      scheduled.push(args);
    },
    unschedule: async (...args: unknown[]) => {
      unscheduled.push(args);
    }
  };
  return { boss, scheduled, unscheduled };
}

describe("digest schedule key", () => {
  it("builds a key the job scheduler accepts", () => {
    const key = digestScheduleKey(USER_ID);

    expect(key).toBe(`digest-${USER_ID}`);
    expect(key).toMatch(PG_BOSS_KEY_PATTERN);
  });

  it("schedules with the dash key and removes any schedule stored under the old colon key", async () => {
    const { boss, scheduled, unscheduled } = fakeScheduler();

    await reconcileDigestSchedule(boss, USER_ID, {
      enabled: true,
      cadence: "daily",
      scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
      lastDigestSentAt: null
    });

    expect(unscheduled).toContainEqual([DIGEST_COMPOSE_QUEUE, `digest:${USER_ID}`]);
    expect(scheduled).toHaveLength(1);
    const options = scheduled[0]?.[3] as { key: string };
    expect(options.key).toBe(`digest-${USER_ID}`);
    expect(options.key).toMatch(PG_BOSS_KEY_PATTERN);
  });

  it("switching off removes both the current and the old colon key", async () => {
    const { boss, scheduled, unscheduled } = fakeScheduler();

    await reconcileDigestSchedule(boss, USER_ID, {
      enabled: false,
      cadence: "daily",
      scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
      lastDigestSentAt: null
    });

    expect(scheduled).toHaveLength(0);
    expect(unscheduled).toContainEqual([DIGEST_COMPOSE_QUEUE, `digest-${USER_ID}`]);
    expect(unscheduled).toContainEqual([DIGEST_COMPOSE_QUEUE, `digest:${USER_ID}`]);
  });

  it("keeps the payload idempotency key unchanged", () => {
    // This key lives inside the job payload. The scheduler never checks it as a
    // schedule key, and other modules use the same colon shape in payloads.
    expect(digestScheduleData(USER_ID).idempotencyKey).toBe(`digest:${USER_ID}`);
  });
});

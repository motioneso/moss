import { describe, expect, it, vi } from "vitest";

import { reconcileGoogleAccountSchedule } from "../../packages/connectors/src/google-schedule.js";

describe("reconcileGoogleAccountSchedule", () => {
  it("schedules valid stable metadata with native per-actor coalescing", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { schedule, unschedule: vi.fn() };
    await reconcileGoogleAccountSchedule(boss as never, "actor-1", true);
    expect(schedule).toHaveBeenCalledWith(
      "connectors.google-sync",
      expect.any(String),
      {
        actorUserId: "actor-1",
        kind: "google-sync",
        idempotencyKey: "schedule:actor-1",
        trigger: "schedule"
      },
      { tz: "UTC", key: "actor-1", singletonKey: "actor-1" }
    );
  });

  it("unschedules when disconnected", async () => {
    const unschedule = vi.fn().mockResolvedValue(undefined);
    const boss = { schedule: vi.fn(), unschedule };
    await reconcileGoogleAccountSchedule(boss as never, "actor-1", false);
    expect(unschedule).toHaveBeenCalledWith("connectors.google-sync", "actor-1");
  });
});

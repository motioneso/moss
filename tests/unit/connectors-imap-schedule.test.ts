import { describe, expect, it, vi } from "vitest";

import { reconcileImapAccountSchedule } from "../../packages/connectors/src/imap-schedule.js";

const ACTOR = "00000000-0000-4000-8000-000000000001";

describe("reconcileImapAccountSchedule", () => {
  it("schedules a 15-min cron keyed by connectorAccountId with actorUserId in the payload", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { schedule, unschedule: vi.fn() };
    await reconcileImapAccountSchedule(boss as never, ACTOR, "account-1", true);
    expect(schedule).toHaveBeenCalledWith(
      "connectors.imap-sync",
      expect.any(String),
      {
        actorUserId: ACTOR,
        connectorAccountId: "account-1",
        kind: "imap-sync",
        trigger: "schedule"
      },
      { tz: "UTC", key: "account-1" }
    );
  });

  it("unschedules by connectorAccountId when disconnected", async () => {
    const unschedule = vi.fn().mockResolvedValue(undefined);
    const boss = { schedule: vi.fn(), unschedule };
    await reconcileImapAccountSchedule(boss as never, ACTOR, "account-1", false);
    expect(unschedule).toHaveBeenCalledWith("connectors.imap-sync", "account-1");
  });

  it("payload is metadata-only — allowlisted keys, no password/secret", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { schedule, unschedule: vi.fn() };
    await reconcileImapAccountSchedule(boss as never, ACTOR, "account-1", true);
    const [, , payload] = schedule.mock.calls[0] ?? [];
    expect(Object.keys(payload).sort()).toEqual([
      "actorUserId",
      "connectorAccountId",
      "kind",
      "trigger"
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/password|secret/i);
  });
});

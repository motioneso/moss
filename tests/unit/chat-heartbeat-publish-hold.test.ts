import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { NotificationsRepository, type QuietHoursPort } from "@moss/notifications";

import {
  HEARTBEAT_QUIET_HOURS_HOLD_LINE,
  heartbeatIntroWithHold
} from "../../packages/chat/src/heartbeat/publish.js";

/**
 * #3832: the held-push badge on the Notifications list was unreachable, so the hold is shown on
 * the check-in message instead. The line is server-written, plain, and carries no number (every
 * check-in intro is number-free because it has no evidence record behind it).
 */
describe("heartbeat check-in quiet hours line", () => {
  it("leaves the model's intro alone when the alert is not held", () => {
    expect(heartbeatIntroWithHold("Quick check-in.", false)).toBe("Quick check-in.");
    expect(heartbeatIntroWithHold("", false)).toBe("");
  });

  it("adds one plain line when quiet hours hold the alert", () => {
    const intro = heartbeatIntroWithHold("Quick check-in.", true);
    expect(intro).toBe(`Quick check-in. ${HEARTBEAT_QUIET_HOURS_HOLD_LINE}`);
    expect(intro).not.toMatch(/\d/);
    expect(HEARTBEAT_QUIET_HOURS_HOLD_LINE).toContain("quiet hours end");
  });

  it("shows only the line when the model sent no intro", () => {
    expect(heartbeatIntroWithHold("", true)).toBe(HEARTBEAT_QUIET_HOURS_HOLD_LINE);
  });

  it("does not add the line twice", () => {
    const once = heartbeatIntroWithHold("Quick check-in.", true);
    expect(heartbeatIntroWithHold(once, true)).toBe(once);
  });
});

/**
 * The line may only claim a hold when an alert would actually have gone out now. These are the
 * rules `create()` applies; the check-in asks the same question so the sentence stays true.
 */
describe("quiet hours hold for a normal chat alert", () => {
  const scopedDb = { [dataContextBrand]: true } as unknown as DataContextDb;
  const at2300 = new Date("2026-10-30T23:00:00.000Z");
  // 23:00 in a 22:00-07:00 window releases at 07:00 the next morning.
  const expectedRelease = Date.parse("2026-10-31T07:00:00.000Z");

  function repository(options: {
    readonly quietHours: boolean;
    readonly sensitivity?: "quiet" | "balanced" | "proactive";
    readonly moduleEnabled?: boolean;
  }): NotificationsRepository {
    const quietHoursPort: QuietHoursPort = {
      getSettings: async () => ({
        enabled: options.quietHours,
        start: "22:00",
        end: "07:00",
        timezone: "UTC"
      }),
      getLocaleTimezone: async () => "UTC"
    };
    return new NotificationsRepository(quietHoursPort, {
      isModuleEnabled: async () => options.moduleEnabled ?? true,
      getSensitivity: async () => options.sensitivity ?? "balanced"
    });
  }

  it("reports when a held alert is released", async () => {
    const release = await repository({ quietHours: true }).quietHoursHoldUntil(scopedDb, {
      moduleId: "chat",
      urgency: "normal",
      now: at2300
    });
    expect(release?.getTime()).toBe(expectedRelease);
  });

  it("reports no hold when quiet hours are off", async () => {
    await expect(
      repository({ quietHours: false }).quietHoursHoldUntil(scopedDb, {
        moduleId: "chat",
        urgency: "normal",
        now: at2300
      })
    ).resolves.toBeNull();
  });

  it("reports no hold when the saved sensitivity sends no immediate alert", async () => {
    await expect(
      repository({ quietHours: true, sensitivity: "quiet" }).quietHoursHoldUntil(scopedDb, {
        moduleId: "chat",
        urgency: "normal",
        now: at2300
      })
    ).resolves.toBeNull();
  });

  it("reports no hold when chat alerts are switched off", async () => {
    await expect(
      repository({ quietHours: true, moduleEnabled: false }).quietHoursHoldUntil(scopedDb, {
        moduleId: "chat",
        urgency: "normal",
        now: at2300
      })
    ).resolves.toBeNull();
  });
});

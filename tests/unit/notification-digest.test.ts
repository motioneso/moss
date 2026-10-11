import { describe, expect, it } from "vitest";

import {
  DIGEST_COMPOSE_QUEUE,
  digestPreferenceFromRaw,
  digestScheduleData,
  reconcileDigestSchedule,
  renderNotificationDigest
} from "@moss/notifications";

describe("notification digest preferences", () => {
  it("defaults disabled with daily 07:00 UTC metadata", () => {
    expect(digestPreferenceFromRaw(null)).toEqual({
      enabled: false,
      cadence: "daily",
      scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
      lastDigestSentAt: null
    });
  });

  it("normalizes unsupported cadence and invalid watermark", () => {
    expect(
      digestPreferenceFromRaw({
        enabled: true,
        cadence: "hourly",
        scheduleMetadata: { targetTime: "09:30", timezone: "America/New_York" },
        lastDigestSentAt: "not-a-date"
      })
    ).toEqual({
      enabled: true,
      cadence: "daily",
      scheduleMetadata: { targetTime: "09:30", timezone: "America/New_York" },
      lastDigestSentAt: null,
      lastDigestSentId: null
    });
  });
});

describe("notification digest scheduling", () => {
  it("uses briefing cron/timezone helpers and metadata-only payload", async () => {
    const calls: unknown[][] = [];
    await reconcileDigestSchedule(
      {
        schedule: async (...args: unknown[]) => {
          calls.push(args);
        },
        unschedule: async () => undefined
      } as never,
      "11111111-1111-4111-8111-111111111111",
      {
        enabled: true,
        cadence: "weekly",
        scheduleMetadata: { targetTime: "09:30", timezone: "America/New_York", dayOfWeek: 2 },
        lastDigestSentAt: null
      }
    );

    expect(calls).toEqual([
      [
        DIGEST_COMPOSE_QUEUE,
        "30 9 * * 2",
        digestScheduleData("11111111-1111-4111-8111-111111111111"),
        { tz: "America/New_York", key: "digest:11111111-1111-4111-8111-111111111111" }
      ]
    ]);
  });

  it("unschedules disabled digest", async () => {
    const calls: unknown[][] = [];
    await reconcileDigestSchedule(
      {
        schedule: async () => undefined,
        unschedule: async (...args: unknown[]) => {
          calls.push(args);
        }
      } as never,
      "11111111-1111-4111-8111-111111111111",
      {
        enabled: false,
        cadence: "daily",
        scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
        lastDigestSentAt: null
      }
    );

    expect(calls).toEqual([[DIGEST_COMPOSE_QUEUE, "digest:11111111-1111-4111-8111-111111111111"]]);
  });
});

describe("notification digest rendering", () => {
  it("renders only serialized notification text and a settings link", () => {
    const rendered = renderNotificationDigest({
      baseUrl: "https://jarvis.example.test",
      notifications: [
        {
          id: "n1",
          moduleId: "briefings",
          actorUserId: "u1",
          recipientUserId: "u1",
          title: "Briefing ready",
          body: "Open Moss",
          metadata: {
            accessToken: "SECRET-TOKEN",
            password: "SECRET-PASSWORD",
            rawBody: "RAW-PRIVATE-PAYLOAD"
          },
          readAt: null,
          createdAt: "2026-07-08T12:00:00.000Z",
          href: null
        }
      ]
    });

    expect(rendered.subject).toBe("Moss notification digest");
    expect(rendered.text).toContain("Briefing ready");
    expect(rendered.text).toContain("Open Moss");
    expect(rendered.text).toContain("https://jarvis.example.test/settings?section=notifications");
    expect(`${rendered.text}\n${rendered.html}`).not.toContain("SECRET-TOKEN");
    expect(`${rendered.text}\n${rendered.html}`).not.toContain("SECRET-PASSWORD");
    expect(`${rendered.text}\n${rendered.html}`).not.toContain("RAW-PRIVATE-PAYLOAD");
  });
});

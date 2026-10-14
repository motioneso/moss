import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import { rankPriorityCandidates } from "@moss/priority";
import type { PriorityPreferencesRepository } from "@moss/priority";
import {
  AntiSpamPolicy,
  ProactiveScanner,
  type CardRepository,
  type MonitorStateRepository,
  type ProactiveMonitoringPreferencesRepository,
  type ProactiveQuietPolicy
} from "@moss/proactive-monitoring";
import {
  defaultProactiveMonitoringPreference,
  type ProactiveMonitoringPreferenceV1
} from "@moss/shared";

vi.mock("@moss/priority", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, rankPriorityCandidates: vi.fn() };
});

const OWNER = "00000000-0000-4000-8000-0000000000a1";

// 12:00 UTC is 08:00 in New York, so a 07:00-09:00 New York window is quiet now while the
// same wall times read in UTC are not.
const NOW = "2026-09-01T12:00:00.000Z";
const NEW_YORK_MORNING: ProactiveQuietPolicy = {
  enabled: true,
  startLocalTime: "07:00",
  endLocalTime: "09:00",
  timeZone: "America/New_York"
};

function fakeScopedDb(): DataContextDb {
  return {
    [dataContextBrand]: true as const,
    db: {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(undefined)
          })
        })
      })
    }
  } as unknown as DataContextDb;
}

function calendarPref(nestedQuietEnabled: boolean): ProactiveMonitoringPreferenceV1 {
  const base = defaultProactiveMonitoringPreference();
  return {
    ...base,
    enabled: true,
    quietHours: { enabled: nestedQuietEnabled, startLocalTime: "11:00", endLocalTime: "13:00" },
    sources: {
      tasks: { enabled: false, dailyCardCap: 3 },
      calendar: { enabled: true, dailyCardCap: 3 },
      email: { enabled: false, dailyCardCap: 3 },
      notes: { enabled: false, dailyCardCap: 3 }
    }
  };
}

function spamHarness() {
  const cardRepo = {
    isDismissedStableKeySuppressed: vi.fn().mockResolvedValue(false),
    getActiveCounts: vi.fn().mockResolvedValue({ totalToday: 0, sourceToday: 0, sourceLastHour: 0 })
  } as unknown as CardRepository;
  return { policy: new AntiSpamPolicy(cardRepo), cardRepo };
}

describe("alert quiet hours follow the saved schedule", () => {
  it("defers on the saved schedule in its own zone, not the alert record or the locale zone", async () => {
    const { policy } = spamHarness();
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER,
      "calendar",
      "key-1",
      calendarPref(false),
      NOW,
      "UTC",
      NEW_YORK_MORNING
    );
    expect(verdict).toEqual({ allow: true, deferredUntil: "2026-09-01T13:00:00.000Z" });
  });

  it("keeps the cap day on the owner locale zone when the saved schedule names another zone", async () => {
    const { policy, cardRepo } = spamHarness();
    await policy.check(
      fakeScopedDb(),
      OWNER,
      "calendar",
      "key-1",
      calendarPref(false),
      NOW,
      "UTC",
      NEW_YORK_MORNING
    );
    expect(vi.mocked(cardRepo.getActiveCounts)).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      "calendar",
      NOW,
      "2026-09-01T00:00:00.000Z"
    );
  });

  it("does not defer when the saved schedule is off, even inside the older alert window", async () => {
    const { policy } = spamHarness();
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER,
      "calendar",
      "key-1",
      calendarPref(true),
      NOW,
      "UTC",
      { ...NEW_YORK_MORNING, enabled: false }
    );
    expect(verdict).toEqual({ allow: true, deferredUntil: null });
  });

  it("keeps the older alert window when no saved schedule governs", async () => {
    const { policy } = spamHarness();
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER,
      "calendar",
      "key-1",
      calendarPref(true),
      NOW,
      "UTC",
      null
    );
    expect(verdict).toEqual({ allow: true, deferredUntil: "2026-09-01T13:00:00.000Z" });
  });
});

describe("scanner quiet-hours resolver", () => {
  it("asks the injected resolver once per scan and hands its policy to the spam filter", async () => {
    const pref = calendarPref(true);
    const signal = {
      source: "calendar",
      stableKey: "event-1",
      sourceRefHash: "hash-event-1",
      signalType: "prep_needed",
      title: "Board review",
      summary: "Board review summary",
      occurredAt: NOW,
      priorityCandidate: {}
    };
    vi.mocked(rankPriorityCandidates).mockReturnValue([
      { key: "0", band: "high", score: 90, reasons: [] }
    ] as never);
    const resolveQuietHours = vi.fn().mockResolvedValue(NEW_YORK_MORNING);
    const antiSpam = {
      check: vi.fn().mockResolvedValue({ allow: false, reason: "source_hourly_cap" })
    } as unknown as AntiSpamPolicy;
    const scopedDb = fakeScopedDb();
    const scanner = new ProactiveScanner({
      preferencesRepository: {
        get: vi.fn().mockResolvedValue(pref),
        getSaved: vi.fn().mockResolvedValue({
          raw: { ...pref },
          preference: pref,
          hasLegacyEmailChoice: true
        })
      } as unknown as ProactiveMonitoringPreferencesRepository,
      priorityPreferencesRepository: {
        get: vi.fn().mockReturnValue({ anchors: [] })
      } as unknown as PriorityPreferencesRepository,
      monitorStateRepository: {
        get: vi.fn().mockResolvedValue(null),
        advanceCursor: vi.fn().mockResolvedValue(undefined),
        recordFailure: vi.fn().mockResolvedValue(undefined)
      } as unknown as MonitorStateRepository,
      cardRepository: {
        findByStableKey: vi.fn().mockResolvedValue(null),
        upsertCard: vi.fn().mockResolvedValue({})
      } as unknown as CardRepository,
      antiSpamPolicy: antiSpam,
      getLocalePreference: vi.fn().mockResolvedValue({ timezone: "UTC" }),
      resolveQuietHours
    });
    const provider = {
      source: "calendar",
      moduleId: "calendar",
      collectSignals: vi.fn().mockResolvedValue({ signals: [signal], nextCursor: { cursor: 1 } })
    } as unknown as ProactiveMonitorProvider;

    await scanner.scan(scopedDb, OWNER, "calendar", provider, "source-sync", new Date(NOW));

    expect(resolveQuietHours).toHaveBeenCalledTimes(1);
    expect(resolveQuietHours).toHaveBeenCalledWith(scopedDb);
    expect(vi.mocked(antiSpam.check)).toHaveBeenCalledWith(
      scopedDb,
      OWNER,
      "calendar",
      "event-1",
      pref,
      NOW,
      "UTC",
      NEW_YORK_MORNING
    );
  });
});

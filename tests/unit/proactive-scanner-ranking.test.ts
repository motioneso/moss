import { describe, expect, it, vi } from "vitest";

import { dataContextBrand } from "@moss/db";
import type { DataContextDb } from "@moss/db";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import type {
  AntiSpamPolicy,
  CardRepository,
  MonitorStateRepository,
  ProactiveMonitoringPreferencesRepository
} from "@moss/proactive-monitoring";
import { ProactiveScanner } from "@moss/proactive-monitoring";
import type { PriorityPreferencesRepository } from "@moss/priority";
import { rankPriorityCandidates } from "@moss/priority";
import { defaultProactiveMonitoringPreference } from "@moss/shared";

vi.mock("@moss/priority", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, rankPriorityCandidates: vi.fn() };
});

const enabledCalendarPref = {
  ...defaultProactiveMonitoringPreference(),
  enabled: true,
  sources: {
    tasks: { enabled: false, dailyCardCap: 3 },
    calendar: { enabled: true, dailyCardCap: 3 },
    email: { enabled: false, dailyCardCap: 3 },
    notes: { enabled: false, dailyCardCap: 3 }
  }
};

// Fake DataContextDb satisfying assertDataContextDb brand check.
const fakeScopedDb = {
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

describe("ProactiveScanner: priority band assignment after ranking", () => {
  it("assigns band to signal by title match, not by input-array position — index-swap regression", async () => {
    // Provider returns two signals in order Alpha → Beta.
    const signalAlpha = {
      source: "calendar" as const,
      stableKey: "key-alpha",
      sourceRefHash: "hash-alpha",
      signalType: "prep_needed", // allowed for calendar
      title: "Signal Alpha",
      summary: "Alpha summary",
      occurredAt: "2026-06-28T10:00:00.000Z",
      priorityCandidate: {}
    };
    const signalBeta = {
      source: "calendar" as const,
      stableKey: "key-beta",
      sourceRefHash: "hash-beta",
      signalType: "event_changed_soon", // allowed for calendar
      title: "Signal Beta",
      summary: "Beta summary",
      occurredAt: "2026-06-28T10:00:00.000Z",
      priorityCandidate: {}
    };

    const provider: ProactiveMonitorProvider = {
      source: "calendar",
      moduleId: "calendar",
      collectSignals: vi.fn().mockResolvedValue({
        signals: [signalAlpha, signalBeta],
        nextCursor: {}
      })
    };

    // Ranker returns them REVERSED: Beta=critical, Alpha=high. The keys ride along, so
    // each result still reaches its own signal whatever the order.
    vi.mocked(rankPriorityCandidates).mockReturnValue([
      {
        source: "calendar",
        title: "Signal Beta",
        score: 100,
        band: "critical",
        reasons: [],
        key: "1"
      },
      { source: "calendar", title: "Signal Alpha", score: 80, band: "high", reasons: [], key: "0" }
    ]);

    const mockPrefsRepo = {
      getSaved: vi.fn().mockResolvedValue({
        raw: enabledCalendarPref,
        preference: enabledCalendarPref,
        hasLegacyEmailChoice: true
      })
    } as unknown as ProactiveMonitoringPreferencesRepository;

    const mockPriorityPrefsRepo = {
      get: vi.fn().mockReturnValue({ anchors: [] })
    } as unknown as PriorityPreferencesRepository;

    const mockStateRepo = {
      get: vi.fn().mockResolvedValue(null),
      advanceCursor: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined)
    } as unknown as MonitorStateRepository;

    const mockCardRepo = {
      findByStableKey: vi.fn().mockResolvedValue(null),
      upsertCard: vi.fn().mockResolvedValue(undefined),
      getActiveCounts: vi.fn().mockResolvedValue({
        dailyGlobal: 0,
        dailySource: 0,
        hourlySource: 0
      })
    } as unknown as CardRepository;

    const mockAntiSpam = {
      check: vi.fn().mockResolvedValue({ allow: true, deferredUntil: null })
    } as unknown as AntiSpamPolicy;

    const scanner = new ProactiveScanner({
      preferencesRepository: mockPrefsRepo,
      priorityPreferencesRepository: mockPriorityPrefsRepo,
      monitorStateRepository: mockStateRepo,
      cardRepository: mockCardRepo,
      antiSpamPolicy: mockAntiSpam,
      getLocalePreference: vi.fn().mockResolvedValue({ timezone: "UTC" }),
      resolveQuietHours: async () => null
    });

    const result = await scanner.scan(
      fakeScopedDb,
      "00000000-0000-4000-8000-000000000001",
      "calendar",
      provider,
      "source-sync",
      new Date("2026-06-28T12:00:00.000Z")
    );

    expect(result.skipped).toBe(false);
    expect(result.cardsCreated).toBe(2);

    const upsertCalls = vi.mocked(mockCardRepo.upsertCard).mock.calls;
    expect(upsertCalls).toHaveLength(2);

    // First ranked result (Beta=critical) must produce a card for "Signal Beta" with band "critical".
    expect(upsertCalls[0]?.[1]).toMatchObject({ title: "Signal Beta", priorityBand: "critical" });
    // Second ranked result (Alpha=high) must produce a card for "Signal Alpha" with band "high".
    expect(upsertCalls[1]?.[1]).toMatchObject({ title: "Signal Alpha", priorityBand: "high" });
  });

  // Two allowed signals from one source share a title (recurring Standup events).
  // Monday is first, Tuesday second; the ranker mock decides who scores what.
  async function scanStandups(
    ranked: {
      source: "calendar";
      title: string;
      score: number;
      band: "critical" | "high" | "normal" | "low";
      reasons: string[];
      key: string;
    }[]
  ) {
    const provider: ProactiveMonitorProvider = {
      source: "calendar",
      moduleId: "calendar",
      collectSignals: vi.fn().mockResolvedValue({
        signals: [signalMon, signalTue],
        nextCursor: {}
      })
    };
    vi.mocked(rankPriorityCandidates).mockReturnValue(ranked);

    const mockCardRepo = {
      findByStableKey: vi.fn().mockResolvedValue(null),
      upsertCard: vi.fn().mockResolvedValue(undefined),
      getActiveCounts: vi.fn().mockResolvedValue({
        dailyGlobal: 0,
        dailySource: 0,
        hourlySource: 0
      })
    } as unknown as CardRepository;

    const scanner = new ProactiveScanner({
      preferencesRepository: {
        getSaved: vi.fn().mockResolvedValue({
          raw: enabledCalendarPref,
          preference: enabledCalendarPref,
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
      cardRepository: mockCardRepo,
      antiSpamPolicy: {
        check: vi.fn().mockResolvedValue({ allow: true, deferredUntil: null })
      } as unknown as AntiSpamPolicy,
      getLocalePreference: vi.fn().mockResolvedValue({ timezone: "UTC" }),
      resolveQuietHours: async () => null
    });

    const result = await scanner.scan(
      fakeScopedDb,
      "00000000-0000-4000-8000-000000000001",
      "calendar",
      provider,
      "source-sync",
      new Date("2026-09-29T12:00:00.000Z")
    );
    return { result, upsertCalls: vi.mocked(mockCardRepo.upsertCard).mock.calls };
  }

  const signalMon = {
    source: "calendar" as const,
    stableKey: "mon",
    sourceRefHash: "hash-mon",
    signalType: "event_changed_soon", // allowed for calendar
    title: "Standup",
    summary: "Monday standup moved an hour later",
    occurredAt: "2026-09-28T09:00:00.000Z",
    priorityCandidate: {}
  };
  const signalTue = {
    source: "calendar" as const,
    stableKey: "tue",
    sourceRefHash: "hash-tue",
    signalType: "event_changed_soon", // allowed for calendar
    title: "Standup",
    summary: "Tuesday standup has a new video link",
    occurredAt: "2026-09-29T09:00:00.000Z",
    priorityCandidate: {}
  };

  it("gives the card to Monday when Monday scores high and Tuesday does not — #2609", async () => {
    // The old title match kept the last signal, so Monday's card went to Tuesday.
    const { result, upsertCalls } = await scanStandups([
      { source: "calendar", title: "Standup", score: 80, band: "high", reasons: [], key: "0" },
      { source: "calendar", title: "Standup", score: 30, band: "normal", reasons: [], key: "1" }
    ]);

    expect(result.skipped).toBe(false);
    expect(result.cardsCreated).toBe(1);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.[1]).toMatchObject({
      stableKey: "mon",
      title: "Standup",
      summary: "Monday standup moved an hour later",
      priorityBand: "high"
    });
  });

  it("writes one card per signal when both score high — the issue's probe", async () => {
    // Old code wrote Tuesday's card twice and Monday vanished.
    const { result, upsertCalls } = await scanStandups([
      { source: "calendar", title: "Standup", score: 100, band: "critical", reasons: [], key: "0" },
      { source: "calendar", title: "Standup", score: 80, band: "high", reasons: [], key: "1" }
    ]);

    expect(result.skipped).toBe(false);
    expect(result.cardsCreated).toBe(2);
    expect(upsertCalls.map((call) => (call[1] as { stableKey: string }).stableKey)).toEqual([
      "mon",
      "tue"
    ]);
  });
});

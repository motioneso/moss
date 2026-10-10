/**
 * Verifies that ProactiveScanner associates each ranked PriorityResult with its own
 * originating signal, even when the score order differs from the input order.
 *
 * rankPriorityCandidates sorts internally and returns PriorityResult[] without candidate
 * back-references. A naive ranked[i] ↔ allowedSignals[i] zip would mis-pair signals and
 * results whenever scoring re-orders candidates. The fix builds a title→signal map before
 * ranking and looks up by result.title after.
 */

import { describe, expect, it, vi } from "vitest";

import { dataContextBrand } from "../../packages/db/src/data-context.js";
import type { DataContextDb } from "../../packages/db/src/data-context.js";
import type { AntiSpamPolicy } from "../../packages/proactive-monitoring/src/anti-spam.js";
import type { CardRepository } from "../../packages/proactive-monitoring/src/card-repository.js";
import type { MonitorStateRepository } from "../../packages/proactive-monitoring/src/monitor-state-repository.js";
import type { ProactiveMonitoringPreferencesRepository } from "../../packages/proactive-monitoring/src/preferences-repository.js";
import { ProactiveScanner } from "../../packages/proactive-monitoring/src/scanner.js";
import { PriorityPreferencesRepository } from "@moss/priority";
import { defaultProactiveMonitoringPreference } from "@moss/shared";

const NOW = "2026-06-27T14:00:00.000Z";

function makeMockDb(): DataContextDb {
  return {
    [dataContextBrand]: true as const,
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({ executeTakeFirst: async () => undefined })
        })
      })
    }
  } as unknown as DataContextDb;
}

describe("ProactiveScanner — signal/result pairing after ranking", () => {
  it("each card receives the band and reasons of its OWN signal, not the signal at the same input index", async () => {
    // Signal A — input order 0, scores HIGH (68): needs_reply(+20) + priority5(+30) + due-tomorrow(+18)
    const signalA = {
      source: "email",
      stableKey: "key:A",
      sourceRefHash: "hash:A",
      signalType: "needs_reply_soon",
      title: "Follow-up on project scope",
      summary: "Please reply when available",
      occurredAt: NOW,
      expiresAt: null,
      priorityCandidate: { explicitPriority: 5, dueAt: "2026-06-28T00:00:00Z" }
    };

    // Signal B — input order 1, scores CRITICAL (85): time_sensitive(+20) + priority5(+30) + overdue(+35)
    // Score order: B > A, but input order: A before B — so sorting re-orders them.
    const signalB = {
      source: "email",
      stableKey: "key:B",
      sourceRefHash: "hash:B",
      signalType: "time_sensitive_follow_up",
      title: "URGENT: Contract expires today",
      summary: "Signature required immediately",
      occurredAt: NOW,
      expiresAt: null,
      priorityCandidate: { explicitPriority: 5, dueAt: "2020-01-01T00:00:00Z" }
    };

    const upsertCard = vi.fn().mockResolvedValue({});

    const mockCardRepo = {
      upsertCard,
      findByStableKey: vi.fn().mockResolvedValue(undefined),
      isDismissedStableKeySuppressed: vi.fn().mockResolvedValue(false),
      getActiveCounts: vi
        .fn()
        .mockResolvedValue({ totalToday: 0, sourceToday: 0, sourceLastHour: 0 })
    } as unknown as CardRepository;

    const mockAntiSpam = {
      check: vi.fn().mockResolvedValue({ allow: true, deferredUntil: null })
    } as unknown as AntiSpamPolicy;

    const enabledPref = {
      ...defaultProactiveMonitoringPreference(),
      enabled: true,
      sources: {
        ...defaultProactiveMonitoringPreference().sources,
        email: { enabled: true, dailyCardCap: 10 }
      },
      dailyCardCap: 10,
      quietHours: { enabled: false, startLocalTime: "22:00", endLocalTime: "08:00" }
    };

    const mockPrefsRepo = {
      getSaved: vi.fn().mockResolvedValue({
        raw: enabledPref,
        preference: enabledPref,
        hasLegacyEmailChoice: true
      })
    } as unknown as ProactiveMonitoringPreferencesRepository;

    const mockStateRepo = {
      get: vi.fn().mockResolvedValue(undefined),
      advanceCursor: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined)
    } as unknown as MonitorStateRepository;

    const provider = {
      source: "email",
      moduleId: "email",
      // Signals in input order: A first (high), B second (critical).
      // rankPriorityCandidates will sort B first — the fix must still pair each result
      // with its own signal, not the signal at the same array index.
      collectSignals: vi.fn().mockResolvedValue({ signals: [signalA, signalB], nextCursor: {} })
    };

    const scanner = new ProactiveScanner({
      preferencesRepository: mockPrefsRepo,
      priorityPreferencesRepository: new PriorityPreferencesRepository(),
      monitorStateRepository: mockStateRepo,
      cardRepository: mockCardRepo,
      antiSpamPolicy: mockAntiSpam,
      getLocalePreference: async () => ({ timezone: "UTC" }),
      resolveQuietHours: async () => null
    });

    await scanner.scan(
      makeMockDb(),
      "00000000-0000-0000-0000-000000000001",
      "email",
      provider,
      "manual-refresh",
      new Date(NOW)
    );

    // Both signals qualify (high + critical); two cards must be created.
    expect(upsertCard).toHaveBeenCalledTimes(2);

    const calls = upsertCard.mock.calls.map(
      (c) =>
        c[1] as {
          stableKey: string;
          title: string;
          priorityBand: string;
          priorityReasons: string[];
        }
    );
    const byKey = Object.fromEntries(calls.map((c) => [c.stableKey, c]));

    // Signal B (input order 1) must carry its own CRITICAL band and OVERDUE reason.
    expect(byKey["key:B"]).toBeDefined();
    expect(byKey["key:B"]!.priorityBand).toBe("critical");
    expect(byKey["key:B"]!.priorityReasons).toContain("overdue");
    expect(byKey["key:B"]!.title).toBe("URGENT: Contract expires today");

    // Signal A (input order 0) must carry its own HIGH band and DUE-TOMORROW reason.
    expect(byKey["key:A"]).toBeDefined();
    expect(byKey["key:A"]!.priorityBand).toBe("high");
    expect(byKey["key:A"]!.priorityReasons).toContain("due tomorrow");
    expect(byKey["key:A"]!.title).toBe("Follow-up on project scope");
  });
});

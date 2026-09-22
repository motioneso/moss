import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import {
  AntiSpamPolicy,
  isAllowedSignalType,
  makeProactiveCardVerifier,
  mapSignalType,
  resolveSourcePreference,
  serializeCard,
  validateProactiveMonitoringPreference,
  type CardRepository
} from "@moss/proactive-monitoring";
import {
  defaultProactiveMonitoringPreference,
  type ProactiveMonitoringPreferenceV1
} from "@moss/shared";

const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const OWNER_B = "00000000-0000-4000-8000-0000000000b2";

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

function enabledPref(
  source: "tasks" | "calendar" | "email" | "notes" = "calendar"
): ProactiveMonitoringPreferenceV1 {
  const base = defaultProactiveMonitoringPreference();
  return {
    ...base,
    enabled: true,
    sources: {
      tasks: { enabled: source === "tasks", dailyCardCap: 3 },
      calendar: { enabled: source === "calendar", dailyCardCap: 3 },
      email: { enabled: source === "email", dailyCardCap: 3 },
      notes: { enabled: source === "notes", dailyCardCap: 3 }
    }
  };
}

describe("signal allow-list per source", () => {
  it("allows only the documented task signals", () => {
    expect(isAllowedSignalType("tasks", "overdue_high_priority")).toBe(true);
    expect(isAllowedSignalType("tasks", "due_soon_high_priority")).toBe(true);
    expect(isAllowedSignalType("tasks", "at_risk_focus")).toBe(true);
    expect(isAllowedSignalType("tasks", "prep_needed")).toBe(false);
    expect(isAllowedSignalType("tasks", "needs_reply_soon")).toBe(false);
    expect(isAllowedSignalType("tasks", "")).toBe(false);
  });

  it("allows only the documented calendar signals", () => {
    expect(isAllowedSignalType("calendar", "event_changed_soon")).toBe(true);
    expect(isAllowedSignalType("calendar", "event_cancelled_soon")).toBe(true);
    expect(isAllowedSignalType("calendar", "prep_needed")).toBe(true);
    expect(isAllowedSignalType("calendar", "dense_schedule")).toBe(true);
    expect(isAllowedSignalType("calendar", "overdue_high_priority")).toBe(false);
  });

  it("allows only the documented email signals", () => {
    expect(isAllowedSignalType("email", "needs_reply_soon")).toBe(true);
    expect(isAllowedSignalType("email", "time_sensitive_follow_up")).toBe(true);
    expect(isAllowedSignalType("email", "priority_sender_waiting")).toBe(true);
    expect(isAllowedSignalType("email", "dense_schedule")).toBe(false);
  });

  it("allows only the documented notes signals", () => {
    expect(isAllowedSignalType("notes", "decision_changed")).toBe(true);
    expect(isAllowedSignalType("notes", "priority_anchor_changed")).toBe(true);
    expect(isAllowedSignalType("notes", "open_loop_added")).toBe(true);
    expect(isAllowedSignalType("notes", "prep_needed")).toBe(false);
  });

  it("rejects an unknown source instead of allowing everything", () => {
    expect(isAllowedSignalType("sms" as "tasks", "overdue_high_priority")).toBe(false);
  });
});

describe("provider signal type mapping", () => {
  it("maps every documented provider type to its priority type", () => {
    expect(mapSignalType("overdue_high_priority")).toBe("time_sensitive");
    expect(mapSignalType("due_soon_high_priority")).toBe("time_sensitive");
    expect(mapSignalType("at_risk_focus")).toBe("time_sensitive");
    expect(mapSignalType("event_changed_soon")).toBe("time_sensitive");
    expect(mapSignalType("event_cancelled_soon")).toBe("time_sensitive");
    expect(mapSignalType("prep_needed")).toBe("prep_needed");
    expect(mapSignalType("dense_schedule")).toBe("schedule_density_overload");
    expect(mapSignalType("needs_reply_soon")).toBe("needs_reply");
    expect(mapSignalType("time_sensitive_follow_up")).toBe("time_sensitive");
    expect(mapSignalType("priority_sender_waiting")).toBe("needs_reply");
    expect(mapSignalType("decision_changed")).toBe("planning_impact");
    expect(mapSignalType("priority_anchor_changed")).toBe("planning_impact");
    expect(mapSignalType("open_loop_added")).toBe("planning_impact");
  });

  it("passes an unknown type through unchanged", () => {
    expect(mapSignalType("something_new")).toBe("something_new");
    expect(mapSignalType("")).toBe("");
  });
});

describe("monitoring preference validation", () => {
  it("accepts the default preference with monitoring switched on", () => {
    const pref = { ...defaultProactiveMonitoringPreference(), enabled: true };
    expect(() => validateProactiveMonitoringPreference(pref)).not.toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => validateProactiveMonitoringPreference(null)).toThrow(/must be an object/);
  });

  it("rejects unknown top-level keys", () => {
    const pref = {
      ...defaultProactiveMonitoringPreference(),
      extra: true
    };
    expect(() => validateProactiveMonitoringPreference(pref)).toThrow(/Unknown preference keys/);
  });

  it("rejects a wrong version", () => {
    const pref = { ...defaultProactiveMonitoringPreference(), version: 2 };
    expect(() => validateProactiveMonitoringPreference(pref)).toThrow(/version must be 1/);
  });

  it("rejects a non-boolean enabled flag", () => {
    const pref = {
      ...defaultProactiveMonitoringPreference(),
      enabled: "yes"
    };
    expect(() => validateProactiveMonitoringPreference(pref)).toThrow(/enabled must be boolean/);
  });

  it("rejects a daily cap outside 1-20", () => {
    for (const dailyCardCap of [0, 21]) {
      const pref = { ...defaultProactiveMonitoringPreference(), dailyCardCap };
      expect(() => validateProactiveMonitoringPreference(pref)).toThrow(/dailyCardCap must be 1/);
    }
  });

  it("rejects a missing source block", () => {
    const base = defaultProactiveMonitoringPreference();
    const { tasks: _dropped, ...sources } = base.sources;
    void _dropped;
    expect(() => validateProactiveMonitoringPreference({ ...base, sources })).toThrow(
      /sources\.tasks must be an object/
    );
  });

  it("rejects an unknown source name", () => {
    const base = defaultProactiveMonitoringPreference();
    const pref = {
      ...base,
      sources: { ...base.sources, sms: { enabled: true, dailyCardCap: 1 } }
    };
    expect(() => validateProactiveMonitoringPreference(pref)).toThrow(/Unknown sources: sms/);
  });

  it("rejects a per-source cap outside 1-5", () => {
    const base = defaultProactiveMonitoringPreference();
    const pref = {
      ...base,
      sources: { ...base.sources, tasks: { enabled: true, dailyCardCap: 9 } }
    };
    expect(() => validateProactiveMonitoringPreference(pref)).toThrow(
      /sources\.tasks\.dailyCardCap must be 1/
    );
  });

  it("rejects bad quiet-hours times", () => {
    const base = defaultProactiveMonitoringPreference();
    const pref = {
      ...base,
      quietHours: { enabled: true, startLocalTime: "10pm", endLocalTime: "08:00" }
    };
    expect(() => validateProactiveMonitoringPreference(pref)).toThrow(
      /startLocalTime must be HH:MM/
    );
  });

  it("rejects a non-string updatedAt", () => {
    const pref = {
      ...defaultProactiveMonitoringPreference(),
      updatedAt: 123
    };
    expect(() => validateProactiveMonitoringPreference(pref)).toThrow(/updatedAt must be a string/);
  });
});

describe("per-source preference lookup", () => {
  it("returns the stored source block", () => {
    const pref = enabledPref("email");
    expect(resolveSourcePreference(pref, "email")).toEqual({
      enabled: true,
      dailyCardCap: 3
    });
    expect(resolveSourcePreference(pref, "tasks").enabled).toBe(false);
  });

  it("falls back to disabled when the source block is missing", () => {
    const base = enabledPref("tasks");
    const { email: _dropped, ...sources } = base.sources;
    void _dropped;
    const pref = { ...base, sources } as ProactiveMonitoringPreferenceV1;
    expect(resolveSourcePreference(pref, "email")).toEqual({
      enabled: false,
      dailyCardCap: 3
    });
  });
});

describe("card serialization", () => {
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: "card-1",
      owner_user_id: OWNER_A,
      source: "calendar",
      stable_key: "key-1",
      source_ref_hash: "hash-1",
      title: "Title",
      summary: "Summary",
      signal_type: "prep_needed",
      priority_band: "high",
      priority_reasons: ["soon"],
      status: "active",
      occurred_at: new Date("2026-09-01T10:00:00.000Z"),
      target_at: null,
      first_seen_at: new Date("2026-09-01T11:00:00.000Z"),
      last_seen_at: new Date("2026-09-01T11:00:00.000Z"),
      deferred_until: null,
      created_at: new Date("2026-09-01T11:00:00.000Z"),
      updated_at: new Date("2026-09-01T11:00:00.000Z"),
      ...overrides
    } as unknown as Parameters<typeof serializeCard>[0];
  }

  it("maps every row field onto the card the browser receives", () => {
    const dto = serializeCard(row());
    expect(dto).toMatchObject({
      id: "card-1",
      source: "calendar",
      stableKey: "key-1",
      title: "Title",
      priorityBand: "high",
      status: "active",
      occurredAt: "2026-09-01T10:00:00.000Z"
    });
  });

  it("turns missing dates into null", () => {
    const dto = serializeCard(row({ occurred_at: null, target_at: null }));
    expect(dto.occurredAt).toBeNull();
    expect(dto.targetAt).toBeNull();
  });

  it("accepts date strings as well as Date objects", () => {
    const dto = serializeCard(row({ occurred_at: "2026-09-02T10:00:00.000Z" }));
    expect(dto.occurredAt).toBe("2026-09-02T10:00:00.000Z");
  });
});

describe("proactive card verifier", () => {
  function card(overrides: Record<string, unknown> = {}) {
    return {
      id: "card-9",
      owner_user_id: OWNER_A,
      source: "email",
      title: "Reply to Sam",
      summary: "Short summary",
      priority_band: "high",
      ...overrides
    };
  }

  it("returns null when the card does not exist", async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(undefined)
    } as unknown as CardRepository;
    const verify = makeProactiveCardVerifier(repo);
    const result = await verify(
      {} as never,
      {
        actorUserId: OWNER_A,
        targetRef: "missing"
      } as never
    );
    expect(result).toBeNull();
  });

  it("looks the card up under the requesting user, never anyone else", async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(card())
    } as unknown as CardRepository;
    const verify = makeProactiveCardVerifier(repo);
    await verify(
      {} as never,
      {
        actorUserId: OWNER_B,
        targetRef: "card-9"
      } as never
    );
    expect(repo.findById).toHaveBeenCalledWith(expect.anything(), OWNER_B, "card-9");
  });

  it("reports the card owner from the stored row", async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(card())
    } as unknown as CardRepository;
    const verify = makeProactiveCardVerifier(repo);
    const result = await verify(
      {} as never,
      {
        actorUserId: OWNER_A,
        targetRef: "card-9"
      } as never
    );
    expect(result).toMatchObject({
      ownerUserId: OWNER_A,
      targetKind: "proactive_card",
      sourceKind: "email",
      sourceLabel: "Email"
    });
  });

  it("falls back to the raw source name for an unknown source", async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(card({ source: "pager" }))
    } as unknown as CardRepository;
    const verify = makeProactiveCardVerifier(repo);
    const result = await verify(
      {} as never,
      {
        actorUserId: OWNER_A,
        targetRef: "card-9"
      } as never
    );
    expect(result?.sourceLabel).toBe("pager");
  });

  it("withholds the excerpt when the summary is too long to remember", async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(card({ summary: "x".repeat(500) }))
    } as unknown as CardRepository;
    const verify = makeProactiveCardVerifier(repo);
    const result = await verify(
      {} as never,
      {
        actorUserId: OWNER_A,
        targetRef: "card-9"
      } as never
    );
    expect(result?.canRemember).toBe(false);
    expect(result?.rememberExcerpt).toBeUndefined();
  });

  it("trims a long title-plus-summary to 300 characters", async () => {
    const repo = {
      findById: vi
        .fn()
        .mockResolvedValue(card({ title: "t".repeat(250), summary: "s".repeat(100) }))
    } as unknown as CardRepository;
    const verify = makeProactiveCardVerifier(repo);
    const result = await verify(
      {} as never,
      {
        actorUserId: OWNER_A,
        targetRef: "card-9"
      } as never
    );
    expect(result?.canRemember).toBe(true);
    expect(result?.rememberExcerpt).toHaveLength(300);
  });
});

describe("spam filter", () => {
  function spamHarness(counts = { totalToday: 0, sourceToday: 0, sourceLastHour: 0 }) {
    const cardRepo = {
      isDismissedStableKeySuppressed: vi.fn().mockResolvedValue(false),
      getActiveCounts: vi.fn().mockResolvedValue(counts)
    } as unknown as CardRepository;
    return { policy: new AntiSpamPolicy(cardRepo), cardRepo };
  }

  const pref = () => enabledPref("calendar");

  it("suppresses a card the owner already dismissed", async () => {
    const { policy, cardRepo } = spamHarness();
    vi.mocked(cardRepo.isDismissedStableKeySuppressed).mockResolvedValue(true);
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      "key-1",
      pref(),
      "2026-09-01T12:00:00.000Z",
      "UTC"
    );
    expect(verdict).toEqual({
      allow: false,
      reason: "dismissed_stable_key_suppressed"
    });
  });

  it("suppresses when the global daily cap is reached", async () => {
    const { policy } = spamHarness({ totalToday: 8, sourceToday: 0, sourceLastHour: 0 });
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      "key-1",
      pref(),
      "2026-09-01T12:00:00.000Z",
      "UTC"
    );
    expect(verdict).toEqual({ allow: false, reason: "global_daily_cap" });
  });

  it("suppresses when the per-source daily cap is reached", async () => {
    const { policy } = spamHarness({ totalToday: 0, sourceToday: 3, sourceLastHour: 0 });
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      "key-1",
      pref(),
      "2026-09-01T12:00:00.000Z",
      "UTC"
    );
    expect(verdict).toEqual({ allow: false, reason: "source_daily_cap" });
  });

  it("suppresses a second card from one source within the hour", async () => {
    const { policy } = spamHarness({ totalToday: 0, sourceToday: 0, sourceLastHour: 1 });
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      "key-1",
      pref(),
      "2026-09-01T12:00:00.000Z",
      "UTC"
    );
    expect(verdict).toEqual({ allow: false, reason: "source_hourly_cap" });
  });

  it("defers a card raised during quiet hours", async () => {
    const { policy } = spamHarness();
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      "key-1",
      pref(),
      "2026-09-01T23:00:00.000Z",
      "UTC"
    );
    expect(verdict.allow).toBe(true);
    if (verdict.allow) expect(verdict.deferredUntil).not.toBeNull();
  });

  it("lets a midday card straight through", async () => {
    const { policy } = spamHarness();
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      "key-1",
      pref(),
      "2026-09-01T12:00:00.000Z",
      "UTC"
    );
    expect(verdict).toEqual({ allow: true, deferredUntil: null });
  });

  it("ignores quiet hours when they are switched off", async () => {
    const { policy } = spamHarness();
    const nightPref: ProactiveMonitoringPreferenceV1 = {
      ...pref(),
      quietHours: { enabled: false, startLocalTime: "22:00", endLocalTime: "08:00" }
    };
    const verdict = await policy.check(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      "key-1",
      nightPref,
      "2026-09-01T23:00:00.000Z",
      "UTC"
    );
    expect(verdict).toEqual({ allow: true, deferredUntil: null });
  });

  it("scopes every spam check to the requesting user", async () => {
    const { policy, cardRepo } = spamHarness();
    await policy.check(
      fakeScopedDb(),
      OWNER_B,
      "calendar",
      "key-1",
      pref(),
      "2026-09-01T12:00:00.000Z",
      "UTC"
    );
    expect(cardRepo.isDismissedStableKeySuppressed).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_B,
      "calendar",
      "key-1"
    );
    expect(cardRepo.getActiveCounts).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_B,
      "calendar",
      expect.anything(),
      expect.anything()
    );
  });
});

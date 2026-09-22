import { describe, expect, it, vi, beforeEach } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { assertMetadataOnlyPayload } from "@moss/jobs";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import {
  PROACTIVE_SCAN_SOURCE_QUEUE,
  ProactiveScanner,
  enqueueProactiveScan,
  registerProactiveMonitoringRoutes,
  registerProactiveMonitoringWorkers,
  type AntiSpamPolicy as AntiSpamPolicyType,
  type CardRepository,
  type MonitorStateRepository,
  type ProactiveMonitoringPreferencesRepository
} from "@moss/proactive-monitoring";
import { rankPriorityCandidates } from "@moss/priority";
import type { PriorityPreferencesRepository } from "@moss/priority";
import {
  defaultProactiveMonitoringPreference,
  type ProactiveMonitoringPreferenceV1
} from "@moss/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

vi.mock("@moss/priority", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, rankPriorityCandidates: vi.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type AnyFn = Function;

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

function calendarSignal(title: string, stableKey: string) {
  return {
    source: "calendar",
    stableKey,
    sourceRefHash: `hash-${stableKey}`,
    signalType: "prep_needed",
    title,
    summary: `${title} summary`,
    occurredAt: "2026-09-01T10:00:00.000Z",
    priorityCandidate: {}
  };
}

function providerReturning(signals: ReturnType<typeof calendarSignal>[]): ProactiveMonitorProvider {
  return {
    source: "calendar",
    moduleId: "calendar",
    collectSignals: vi.fn().mockResolvedValue({ signals, nextCursor: { cursor: 1 } })
  } as unknown as ProactiveMonitorProvider;
}

interface ScannerHarness {
  scanner: ProactiveScanner;
  prefsRepo: ProactiveMonitoringPreferencesRepository;
  stateRepo: MonitorStateRepository;
  cardRepo: CardRepository;
  antiSpam: AntiSpamPolicyType;
}

function harness(pref: ProactiveMonitoringPreferenceV1): ScannerHarness {
  const prefsRepo = {
    get: vi.fn().mockResolvedValue(pref)
  } as unknown as ProactiveMonitoringPreferencesRepository;
  const priorityPrefsRepo = {
    get: vi.fn().mockReturnValue({ anchors: [] })
  } as unknown as PriorityPreferencesRepository;
  const stateRepo = {
    get: vi.fn().mockResolvedValue(null),
    advanceCursor: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined)
  } as unknown as MonitorStateRepository;
  const cardRepo = {
    findByStableKey: vi.fn().mockResolvedValue(null),
    upsertCard: vi.fn().mockResolvedValue({}),
    getActiveCounts: vi.fn()
  } as unknown as CardRepository;
  const antiSpam = {
    check: vi.fn().mockResolvedValue({ allow: true, deferredUntil: null })
  } as unknown as AntiSpamPolicyType;
  const scanner = new ProactiveScanner({
    preferencesRepository: prefsRepo,
    priorityPreferencesRepository: priorityPrefsRepo,
    monitorStateRepository: stateRepo,
    cardRepository: cardRepo,
    antiSpamPolicy: antiSpam,
    getLocalePreference: vi.fn().mockResolvedValue({ timezone: "UTC" })
  });
  return { scanner, prefsRepo, stateRepo, cardRepo, antiSpam };
}

beforeEach(() => {
  vi.mocked(rankPriorityCandidates).mockReset();
  vi.mocked(rankPriorityCandidates).mockReturnValue([]);
});
describe("scanner skip paths", () => {
  const NOW = new Date("2026-09-01T12:00:00.000Z");

  it("skips when monitoring is switched off without calling the provider", async () => {
    const { scanner } = harness(defaultProactiveMonitoringPreference());
    const provider = providerReturning([calendarSignal("T", "k")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ skipped: true, skipReason: "monitoring_disabled" });
    expect(provider.collectSignals).not.toHaveBeenCalled();
  });

  it("skips when the source is switched off", async () => {
    const { scanner } = harness(enabledPref("tasks"));
    const provider = providerReturning([calendarSignal("T", "k")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ skipped: true, skipReason: "source_disabled" });
    expect(provider.collectSignals).not.toHaveBeenCalled();
  });

  it("skips a manual refresh inside the 15-minute cooldown", async () => {
    const { scanner, stateRepo } = harness(enabledPref("calendar"));
    vi.mocked(stateRepo.get).mockResolvedValue({
      last_checked_at: new Date("2026-09-01T11:55:00.000Z")
    } as never);
    const provider = providerReturning([calendarSignal("T", "k")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "manual-refresh",
      NOW
    );
    expect(result).toMatchObject({ skipped: true, skipReason: "cooldown" });
    expect(provider.collectSignals).not.toHaveBeenCalled();
  });

  it("lets a source sync through inside the cooldown", async () => {
    const { scanner, stateRepo } = harness(enabledPref("calendar"));
    vi.mocked(stateRepo.get).mockResolvedValue({
      last_checked_at: new Date("2026-09-01T11:55:00.000Z"),
      cursor_json: {}
    } as never);
    vi.mocked(rankPriorityCandidates).mockReturnValue([]);
    const provider = providerReturning([]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result.skipped).toBe(false);
    expect(provider.collectSignals).toHaveBeenCalled();
  });

  it("records a provider failure and skips", async () => {
    const { scanner, stateRepo } = harness(enabledPref("calendar"));
    const provider: ProactiveMonitorProvider = {
      source: "calendar",
      moduleId: "calendar",
      collectSignals: vi.fn().mockRejectedValue(new TypeError("down"))
    } as unknown as ProactiveMonitorProvider;
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ skipped: true, skipReason: "provider_error" });
    expect(stateRepo.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_A,
      "calendar",
      "TypeError"
    );
    expect(stateRepo.advanceCursor).not.toHaveBeenCalled();
  });

  it("advances the cursor and skips when scoring throws", async () => {
    const { scanner, stateRepo } = harness(enabledPref("calendar"));
    vi.mocked(rankPriorityCandidates).mockImplementation(() => {
      throw new Error("scorer down");
    });
    const provider = providerReturning([calendarSignal("T", "k")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ skipped: true, skipReason: "scorer_error" });
    expect(stateRepo.advanceCursor).toHaveBeenCalledWith(expect.anything(), OWNER_A, "calendar", {
      cursor: 1
    });
  });

  it("falls back to UTC when no timezone preference exists", async () => {
    const prefsRepo = {
      get: vi.fn().mockResolvedValue(enabledPref("calendar"))
    } as unknown as ProactiveMonitoringPreferencesRepository;
    const priorityPrefsRepo = {
      get: vi.fn().mockReturnValue({ anchors: [] })
    } as unknown as PriorityPreferencesRepository;
    const stateRepo = {
      get: vi.fn().mockResolvedValue(null),
      advanceCursor: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined)
    } as unknown as MonitorStateRepository;
    const cardRepo = {
      findByStableKey: vi.fn().mockResolvedValue(null),
      upsertCard: vi.fn().mockResolvedValue({})
    } as unknown as CardRepository;
    const antiSpam = {
      check: vi.fn().mockResolvedValue({ allow: true, deferredUntil: null })
    } as unknown as AntiSpamPolicyType;
    const scanner = new ProactiveScanner({
      preferencesRepository: prefsRepo,
      priorityPreferencesRepository: priorityPrefsRepo,
      monitorStateRepository: stateRepo,
      cardRepository: cardRepo,
      antiSpamPolicy: antiSpam,
      getLocalePreference: vi.fn().mockResolvedValue(null)
    });
    const provider = providerReturning([]);
    await scanner.scan(fakeScopedDb(), OWNER_A, "calendar", provider, "source-sync", NOW);
    expect(provider.collectSignals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeZone: "UTC" })
    );
  });
});

describe("scanner card outcomes", () => {
  const NOW = new Date("2026-09-01T12:00:00.000Z");

  function rankedHigh(title: string, band: "critical" | "high" | "normal" | "low" = "high") {
    return { source: "calendar", title, score: 90, band, reasons: ["soon"] };
  }

  it("creates a card for a new high-priority signal and moves the cursor", async () => {
    const { scanner, cardRepo, stateRepo } = harness(enabledPref("calendar"));
    vi.mocked(rankPriorityCandidates).mockReturnValue([rankedHigh("Signal A")] as never);
    const provider = providerReturning([calendarSignal("Signal A", "key-a")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({
      skipped: false,
      signalsReceived: 1,
      cardsCreated: 1,
      cardsUpdated: 0
    });
    expect(cardRepo.upsertCard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerUserId: OWNER_A,
        stableKey: "key-a",
        priorityBand: "high"
      })
    );
    expect(stateRepo.advanceCursor).toHaveBeenCalledWith(expect.anything(), OWNER_A, "calendar", {
      cursor: 1
    });
  });

  it("counts an update when the card already exists", async () => {
    const { scanner, cardRepo } = harness(enabledPref("calendar"));
    vi.mocked(rankPriorityCandidates).mockReturnValue([rankedHigh("Signal A")] as never);
    vi.mocked(cardRepo.findByStableKey).mockResolvedValue({ id: "existing" } as never);
    const provider = providerReturning([calendarSignal("Signal A", "key-a")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ cardsCreated: 0, cardsUpdated: 1 });
  });

  it("counts a deferral when the spam filter defers", async () => {
    const { scanner, antiSpam } = harness(enabledPref("calendar"));
    vi.mocked(rankPriorityCandidates).mockReturnValue([rankedHigh("Signal A")] as never);
    vi.mocked(antiSpam.check).mockResolvedValue({
      allow: true,
      deferredUntil: "2026-09-02T08:00:00.000Z"
    });
    const provider = providerReturning([calendarSignal("Signal A", "key-a")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ cardsDeferred: 1, cardsCreated: 0 });
  });

  it("counts a suppression and writes no card", async () => {
    const { scanner, cardRepo, antiSpam } = harness(enabledPref("calendar"));
    vi.mocked(rankPriorityCandidates).mockReturnValue([rankedHigh("Signal A")] as never);
    vi.mocked(antiSpam.check).mockResolvedValue({ allow: false, reason: "source_hourly_cap" });
    const provider = providerReturning([calendarSignal("Signal A", "key-a")]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ cardsSuppressed: 1 });
    expect(cardRepo.upsertCard).not.toHaveBeenCalled();
  });

  it("ignores signals whose type is not allowed for the source", async () => {
    const { scanner, cardRepo } = harness(enabledPref("calendar"));
    const allowed = calendarSignal("Allowed", "key-ok");
    const foreign = {
      ...calendarSignal("Foreign", "key-foreign"),
      signalType: "needs_reply_soon"
    };
    vi.mocked(rankPriorityCandidates).mockReturnValue([
      rankedHigh("Allowed"),
      rankedHigh("Foreign")
    ] as never);
    const provider = providerReturning([allowed, foreign]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result.signalsReceived).toBe(2);
    expect(result.cardsCreated).toBe(1);
    expect(vi.mocked(cardRepo.upsertCard).mock.calls[0]?.[1]).toMatchObject({
      title: "Allowed"
    });
  });

  it("creates no cards for normal or low bands", async () => {
    const { scanner, cardRepo } = harness(enabledPref("calendar"));
    vi.mocked(rankPriorityCandidates).mockReturnValue([
      rankedHigh("Mild", "normal"),
      rankedHigh("Trivia", "low")
    ] as never);
    const provider = providerReturning([
      calendarSignal("Mild", "key-mild"),
      calendarSignal("Trivia", "key-trivia")
    ]);
    const result = await scanner.scan(
      fakeScopedDb(),
      OWNER_A,
      "calendar",
      provider,
      "source-sync",
      NOW
    );
    expect(result).toMatchObject({ cardsCreated: 0, cardsUpdated: 0 });
    expect(cardRepo.upsertCard).not.toHaveBeenCalled();
  });
});

describe("scanner keeps users apart", () => {
  const NOW = new Date("2026-09-01T12:00:00.000Z");

  it("never lets one user's signals reach another user", async () => {
    const { scanner, cardRepo, stateRepo } = harness(enabledPref("calendar"));
    vi.mocked(rankPriorityCandidates).mockImplementation(((args: unknown) => {
      const input = args as { candidates: { title: string }[] };
      return input.candidates.map((c) => ({
        source: "calendar",
        title: c.title,
        score: 95,
        band: "critical",
        reasons: []
      }));
    }) as never);

    const providerA = providerReturning([calendarSignal("Owner A bill", "key-a1")]);
    const providerB = providerReturning([calendarSignal("Owner B bill", "key-b1")]);

    await scanner.scan(fakeScopedDb(), OWNER_A, "calendar", providerA, "source-sync", NOW);
    await scanner.scan(fakeScopedDb(), OWNER_B, "calendar", providerB, "source-sync", NOW);

    expect(providerA.collectSignals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: OWNER_A })
    );
    expect(providerB.collectSignals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: OWNER_B })
    );

    const upserts = vi.mocked(cardRepo.upsertCard).mock.calls.map((call) => call[1]);
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toMatchObject({ ownerUserId: OWNER_A, title: "Owner A bill" });
    expect(upserts[1]).toMatchObject({ ownerUserId: OWNER_B, title: "Owner B bill" });

    const cursors = vi.mocked(stateRepo.advanceCursor).mock.calls;
    expect(cursors.map((call) => call[1]).sort()).toEqual([OWNER_A, OWNER_B].sort());
  });
});

describe("scan job queue", () => {
  it("carries only IDs and small parameters, never content", async () => {
    const sent: { queue: string; payload: unknown; options: unknown }[] = [];
    const boss = {
      send: vi.fn(async (queue: string, payload: unknown, options: unknown) => {
        sent.push({ queue, payload, options });
        return "job-id";
      })
    } as unknown as Parameters<typeof enqueueProactiveScan>[0];

    await enqueueProactiveScan(boss, OWNER_A, "email", "manual-refresh", "key-123");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe(PROACTIVE_SCAN_SOURCE_QUEUE.name);
    expect(sent[0]?.payload).toEqual({
      actorUserId: OWNER_A,
      source: "email",
      reason: "manual-refresh",
      idempotencyKey: "key-123"
    });
    expect(sent[0]?.options).toMatchObject({ singletonKey: "key-123" });
    expect(() => assertMetadataOnlyPayload(sent[0]?.payload)).not.toThrow();
  });
});

describe("scan worker", () => {
  type BossParam = Parameters<typeof registerProactiveMonitoringWorkers>[0];
  type DepsParam = Parameters<typeof registerProactiveMonitoringWorkers>[1];

  interface Captured {
    handler: AnyFn;
    workQueue: string;
  }

  function fakeBoss(): { boss: BossParam; captured: Captured; send: ReturnType<typeof vi.fn> } {
    const captured = {} as Captured;
    const send = vi.fn(async () => "job-id");
    const work = vi.fn(async (queue: string, _options: unknown, fn: AnyFn) => {
      captured.handler = fn;
      captured.workQueue = queue;
      return "worker-1";
    });
    return { boss: { work, send } as unknown as BossParam, captured, send };
  }

  function workerDb(
    monitoringPref: ProactiveMonitoringPreferenceV1,
    priorityModel: unknown
  ): DataContextDb {
    // Answers the two preference reads the scanner makes: the monitoring
    // preference for any key, the priority model for its own key. Everything
    // else (monitor state, existing cards) reads empty; raw SQL writes just
    // succeed with no rows.
    const selectFrom = vi.fn((table: string) => {
      const args: unknown[][] = [];
      const chain = {
        select: () => chain,
        selectAll: () => chain,
        where: (...cond: unknown[]) => {
          args.push(cond);
          return chain;
        },
        executeTakeFirst: async () => {
          if (table === "app.preferences") {
            if (args.flat().includes("priority.model.v1")) {
              return { value_json: priorityModel };
            }
            return { value_json: monitoringPref };
          }
          return undefined;
        }
      };
      return chain;
    });
    // Raw SQL runs through the query-executor interface: transform and
    // compile are identity steps, execution answers no rows.
    const executeQuery = vi.fn(async () => ({ rows: [] }));
    const executor = {
      transformQuery: (node: unknown) => node,
      compileQuery: () => ({ sql: "", parameters: [] }),
      executeQuery
    };
    return {
      [dataContextBrand]: true as const,
      db: {
        selectFrom,
        executeQuery,
        getExecutor: () => executor
      }
    } as unknown as DataContextDb;
  }

  function emptyPriorityModel(): unknown {
    return {
      version: 1,
      mode: "balanced",
      anchors: [],
      mutedSources: [],
      updatedAt: "2026-09-01T00:00:00.000Z"
    };
  }

  function tasksPref(): ProactiveMonitoringPreferenceV1 {
    const base = defaultProactiveMonitoringPreference();
    return {
      ...base,
      enabled: true,
      dailyCardCap: 20,
      quietHours: { enabled: false, startLocalTime: "22:00", endLocalTime: "08:00" },
      sources: {
        tasks: { enabled: true, dailyCardCap: 5 },
        calendar: { enabled: false, dailyCardCap: 3 },
        email: { enabled: false, dailyCardCap: 3 },
        notes: { enabled: false, dailyCardCap: 3 }
      }
    };
  }

  it("registers on the scan queue and returns the worker id", async () => {
    const { boss, captured } = fakeBoss();
    const dataContext = {
      withDataContext: vi.fn()
    } as unknown as DepsParam["dataContext"];
    const workers = await registerProactiveMonitoringWorkers(boss, {
      dataContext,
      getLocalePreference: async () => ({ timezone: "UTC" }),
      providers: new Map()
    });
    expect(workers).toEqual(["worker-1"]);
    expect(captured.workQueue).toBe("proactive-scan-source");
  });

  it("rejects a job payload that smuggles content", async () => {
    const { boss, captured } = fakeBoss();
    // The payload guard lives inside the handler, so the runner opens the
    // context first and the handler itself throws.
    const withDataContext = vi.fn(async (_ctx: unknown, fn: AnyFn) => fn({} as never));
    await registerProactiveMonitoringWorkers(boss, {
      dataContext: { withDataContext } as unknown as DepsParam["dataContext"],
      getLocalePreference: async () => ({ timezone: "UTC" }),
      providers: new Map()
    });
    await expect(
      captured.handler([
        {
          id: "job-bad",
          data: { actorUserId: OWNER_A, title: "Private bill", idempotencyKey: "k" }
        }
      ])
    ).rejects.toThrow(/metadata/);
    expect(withDataContext).toHaveBeenCalledTimes(1);
  });

  it("returns early when no provider is registered for the source", async () => {
    const { boss, captured } = fakeBoss();
    // A bare database double: if the worker scanned anyway, the repositories
    // would throw on it. Resolving cleanly proves the early return.
    const withDataContext = vi.fn(async (_ctx: unknown, fn: AnyFn) => fn({} as never));
    await registerProactiveMonitoringWorkers(boss, {
      dataContext: { withDataContext } as unknown as DepsParam["dataContext"],
      getLocalePreference: async () => ({ timezone: "UTC" }),
      providers: new Map()
    });
    await expect(
      captured.handler([
        {
          id: "job-1",
          data: {
            actorUserId: OWNER_A,
            source: "tasks",
            reason: "source-sync",
            idempotencyKey: "k-1"
          }
        }
      ])
    ).resolves.toBeUndefined();
    expect(withDataContext).toHaveBeenCalledTimes(1);
  });

  it("runs the scan inside the job user's data context", async () => {
    const { boss, captured } = fakeBoss();
    const seenContexts: unknown[] = [];
    const provider = {
      source: "tasks",
      moduleId: "tasks",
      collectSignals: vi.fn().mockResolvedValue({ signals: [], nextCursor: {} })
    };
    const dataContext = {
      withDataContext: vi.fn(async (ctx: unknown, fn: AnyFn) => {
        seenContexts.push(ctx);
        return fn(workerDb(tasksPref(), emptyPriorityModel()));
      })
    } as unknown as DepsParam["dataContext"];
    await registerProactiveMonitoringWorkers(boss, {
      dataContext,
      getLocalePreference: async () => ({ timezone: "UTC" }),
      providers: new Map([["tasks", provider]] as never)
    });
    await captured.handler([
      {
        id: "job-2",
        data: {
          actorUserId: OWNER_B,
          source: "tasks",
          reason: "source-sync",
          idempotencyKey: "k-2"
        }
      }
    ]);
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]).toMatchObject({ actorUserId: OWNER_B });
    expect(provider.collectSignals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerUserId: OWNER_B })
    );
  });
});

describe("monitoring routes", () => {
  function captureHandlers(deps: Parameters<typeof registerProactiveMonitoringRoutes>[1]) {
    const handlers = new Map<string, AnyFn>();
    const server = {
      get: vi.fn((path: string, handler: AnyFn) => handlers.set(`GET ${path}`, handler)),
      post: vi.fn((path: string, handler: AnyFn) => handlers.set(`POST ${path}`, handler))
    } as unknown as FastifyInstance;
    registerProactiveMonitoringRoutes(server, deps);
    return handlers;
  }

  function reply() {
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    return { send, status, reply: { send, status } as unknown as FastifyReply };
  }

  function depsWith(overrides: Record<string, unknown> = {}) {
    const cardRepository = {
      listActive: vi.fn().mockResolvedValue([])
    };
    const preferencesRepository = {
      get: vi.fn().mockResolvedValue(enabledPref("calendar"))
    };
    const monitorStateRepository = {
      get: vi.fn().mockResolvedValue(null)
    };
    const seenContexts: unknown[] = [];
    const base = {
      resolveAccessContext: async () => ({ actorUserId: OWNER_A }),
      dataContext: {
        withDataContext: async (_ctx: unknown, fn: AnyFn) => {
          seenContexts.push(_ctx);
          return fn({} as never);
        }
      },
      boss: { send: vi.fn().mockResolvedValue("job") },
      registeredSources: new Set(["calendar"]),
      cardRepository,
      preferencesRepository,
      monitorStateRepository,
      ...overrides
    };
    return {
      base: base as never,
      cardRepository,
      preferencesRepository,
      monitorStateRepository,
      seenContexts
    };
  }

  it("lists the requesting user's cards with a default limit of 5", async () => {
    const { base, cardRepository, seenContexts } = depsWith();
    const handlers = captureHandlers(base);
    const { reply: res, send } = reply();
    const req = { query: {} } as unknown as FastifyRequest;
    await (handlers.get("GET /api/me/proactive-cards") as AnyFn)(req, res);
    expect(seenContexts).toEqual([{ actorUserId: OWNER_A }]);
    expect(cardRepository.listActive).toHaveBeenCalledWith(expect.anything(), OWNER_A, 5);
    expect(send).toHaveBeenCalledWith({ cards: [] });
  });

  it("clamps a large limit to 20", async () => {
    const { base, cardRepository } = depsWith();
    const handlers = captureHandlers(base);
    const { reply: res } = reply();
    const req = { query: { limit: "999" } } as unknown as FastifyRequest;
    await (handlers.get("GET /api/me/proactive-cards") as AnyFn)(req, res);
    expect(cardRepository.listActive).toHaveBeenCalledWith(expect.anything(), OWNER_A, 20);
  });

  it("enqueues nothing when monitoring is switched off", async () => {
    const { base, preferencesRepository } = depsWith();
    vi.mocked(preferencesRepository.get).mockResolvedValue(defaultProactiveMonitoringPreference());
    const handlers = captureHandlers(base);
    const { reply: res, status, send } = reply();
    const req = {} as unknown as FastifyRequest;
    await (handlers.get("POST /api/me/proactive-cards/refresh") as AnyFn)(req, res);
    expect(status).toHaveBeenCalledWith(202);
    expect(send).toHaveBeenCalledWith({ enqueued: 0 });
  });

  it("skips sources that are disabled or have no provider", async () => {
    const { base } = depsWith({
      registeredSources: new Set(["tasks", "calendar", "email", "notes"])
    });
    const handlers = captureHandlers(base);
    const { reply: res, send } = reply();
    const req = {} as unknown as FastifyRequest;
    await (handlers.get("POST /api/me/proactive-cards/refresh") as AnyFn)(req, res);
    expect(send).toHaveBeenCalledWith({ enqueued: 1 });
  });

  it("skips a source refreshed inside the cooldown", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
      const { base, monitorStateRepository } = depsWith();
      vi.mocked(monitorStateRepository.get).mockResolvedValue({
        last_checked_at: new Date("2026-09-01T11:55:00.000Z")
      } as never);
      const handlers = captureHandlers(base);
      const { reply: res, send } = reply();
      const req = {} as unknown as FastifyRequest;
      await (handlers.get("POST /api/me/proactive-cards/refresh") as AnyFn)(req, res);
      expect(send).toHaveBeenCalledWith({ enqueued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys the refresh queue per user and source", async () => {
    const { base, seenContexts } = depsWith();
    const bossSend = (base as { boss: { send: ReturnType<typeof vi.fn> } }).boss.send;
    const handlers = captureHandlers(base);
    const { reply: res, status } = reply();
    await (handlers.get("POST /api/me/proactive-cards/refresh") as AnyFn)(
      {} as FastifyRequest,
      res
    );
    expect(status).toHaveBeenCalledWith(202);
    expect(seenContexts).toEqual([{ actorUserId: OWNER_A }]);
    expect(bossSend).toHaveBeenCalledTimes(1);
    const payload = bossSend.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ actorUserId: OWNER_A, source: "calendar" });
    const options = bossSend.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(String(options?.singletonKey)).toContain(OWNER_A);
    expect(String(options?.singletonKey)).toContain("calendar");
  });
});

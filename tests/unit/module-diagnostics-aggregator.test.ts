import { describe, expect, it, vi } from "vitest";

import {
  aggregateModuleDiagnostics,
  MODULE_DIAGNOSTIC_LIMITS,
  type ModuleDiagnosticObservation,
  type ModuleDiagnosticProvider,
  type RegisteredModuleDiagnosticProvider
} from "@moss/module-sdk";

const ctx = { actorUserId: "user-a", requestId: "req-1" } as const;

/** Each provider must get its OWN context — the runner records how many it handed out. */
function countingRunner(): {
  run: <T>(work: (scopedDb: unknown) => Promise<T>) => Promise<T>;
  contexts: object[];
} {
  const contexts: object[] = [];
  return {
    run: async (work) => {
      const scopedDb = {};
      contexts.push(scopedDb);
      return work(scopedDb);
    },
    contexts
  };
}

function provider(
  observation: ModuleDiagnosticObservation | null | unknown,
  overrides: Partial<ModuleDiagnosticProvider> = {}
): ModuleDiagnosticProvider {
  return {
    domain: "demo",
    providerId: "demo.thing",
    observe: async () => observation as ModuleDiagnosticObservation | null,
    ...overrides
  };
}

function observation(
  patch: Partial<ModuleDiagnosticObservation> = {}
): ModuleDiagnosticObservation {
  return {
    domain: "demo",
    providerId: "demo.thing",
    observedAt: new Date("2026-08-27T10:00:00.000Z").toISOString(),
    status: "ok",
    summary: "Everything is fine.",
    ...patch
  };
}

function registered(
  moduleId: string,
  value: ModuleDiagnosticObservation | null | unknown
): RegisteredModuleDiagnosticProvider {
  return { moduleId, provider: provider(value) };
}

describe("aggregateModuleDiagnostics", () => {
  it("collects the non-null observations and gives each provider its own context", async () => {
    const runner = countingRunner();

    const result = await aggregateModuleDiagnostics(
      [
        registered("news", observation({ domain: "news", providerId: "news.refresh" })),
        registered("quiet", null)
      ],
      runner.run,
      ctx
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.providerId).toBe("news.refresh");
    expect(runner.contexts).toHaveLength(2);
    expect(runner.contexts[0]).not.toBe(runner.contexts[1]);
  });

  it("drops a provider that throws, keeps the rest, and reports only the module id and error name", async () => {
    const runner = countingRunner();
    const onProviderError = vi.fn();
    const boom = new Error("connection string postgres://user:secret@host/db leaked");
    boom.name = "ProviderBlewUp";

    const result = await aggregateModuleDiagnostics(
      [
        {
          moduleId: "broken",
          provider: provider(null, {
            observe: async () => {
              throw boom;
            }
          })
        },
        registered("news", observation({ domain: "news", providerId: "news.refresh" }))
      ],
      runner.run,
      ctx,
      { onProviderError }
    );

    expect(result.map((o) => o.providerId)).toEqual(["news.refresh"]);
    expect(onProviderError).toHaveBeenCalledTimes(1);
    expect(onProviderError).toHaveBeenCalledWith("broken", "ProviderBlewUp");
    const reported = JSON.stringify(onProviderError.mock.calls);
    expect(reported).not.toContain("secret");
    expect(reported).not.toContain("postgres://");
  });

  it("drops a provider that stalls past the deadline without hanging the report", async () => {
    vi.useFakeTimers();
    try {
      const runner = countingRunner();
      const onProviderError = vi.fn();

      const pending = aggregateModuleDiagnostics(
        [
          {
            moduleId: "slow",
            provider: provider(null, {
              observe: () => new Promise<never>(() => {})
            })
          }
        ],
        runner.run,
        ctx,
        { onProviderError }
      );

      await vi.advanceTimersByTimeAsync(MODULE_DIAGNOSTIC_LIMITS.providerTimeoutMs + 10);
      const result = await pending;

      expect(result).toEqual([]);
      expect(onProviderError).toHaveBeenCalledWith("slow", "ProviderTimeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a malformed return rather than passing it through", async () => {
    const runner = countingRunner();
    const onProviderError = vi.fn();

    const result = await aggregateModuleDiagnostics(
      [
        registered("junk", { domain: "demo", status: "ok" }),
        registered("badStatus", observation({ status: "on fire" as never })),
        registered("noSummary", observation({ summary: 42 as never }))
      ],
      runner.run,
      ctx,
      { onProviderError }
    );

    expect(result).toEqual([]);
    expect(onProviderError.mock.calls.map((call) => call[1])).toEqual([
      "MalformedModuleDiagnosticObservation",
      "MalformedModuleDiagnosticObservation",
      "MalformedModuleDiagnosticObservation"
    ]);
  });

  it("drops an observation whose summary is over the cap instead of truncating it", async () => {
    const runner = countingRunner();
    const onProviderError = vi.fn();

    const result = await aggregateModuleDiagnostics(
      [
        registered(
          "chatty",
          observation({ summary: "x".repeat(MODULE_DIAGNOSTIC_LIMITS.summaryMaxLength + 1) })
        )
      ],
      runner.run,
      ctx,
      { onProviderError }
    );

    expect(result).toEqual([]);
    expect(onProviderError).toHaveBeenCalledWith("chatty", "MalformedModuleDiagnosticObservation");
  });

  it("drops an observation whose facts break the scalar, key-count or length caps", async () => {
    const runner = countingRunner();
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: MODULE_DIAGNOSTIC_LIMITS.maxFactKeys + 1 }, (_, i) => [`k${i}`, i])
    );

    const result = await aggregateModuleDiagnostics(
      [
        registered("nested", observation({ facts: { inner: { deep: 1 } } as never })),
        registered("arrayFact", observation({ facts: { list: [1, 2] } as never })),
        registered("wide", observation({ facts: tooManyKeys })),
        registered(
          "longValue",
          observation({
            facts: { note: "y".repeat(MODULE_DIAGNOSTIC_LIMITS.factValueMaxLength + 1) }
          })
        )
      ],
      runner.run,
      ctx
    );

    expect(result).toEqual([]);
  });

  it("keeps an observation whose facts sit inside every cap", async () => {
    const runner = countingRunner();

    const result = await aggregateModuleDiagnostics(
      [
        registered(
          "news",
          observation({
            domain: "news",
            providerId: "news.refresh",
            status: "degraded",
            facts: { state: "idle", itemCount: 12, stale: true, lastFailureKind: null },
            remediationActionId: "news.refreshNews"
          })
        )
      ],
      runner.run,
      ctx
    );

    expect(result).toEqual([
      {
        domain: "news",
        providerId: "news.refresh",
        observedAt: "2026-08-27T10:00:00.000Z",
        status: "degraded",
        summary: "Everything is fine.",
        remediationActionId: "news.refreshNews",
        facts: { state: "idle", itemCount: 12, stale: true, lastFailureKind: null }
      }
    ]);
  });

  it("returns an empty list when no module declares a provider", async () => {
    const runner = countingRunner();
    await expect(aggregateModuleDiagnostics([], runner.run, ctx)).resolves.toEqual([]);
  });
});

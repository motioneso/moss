import type { DataContextDb, MossActionAuditLog, MossErrorLog } from "@moss/db";
import { describe, expect, it, vi } from "vitest";

import { createPlatformDiagnosticsService, type PlatformDiagnosticsReport } from "@moss/ai";

const scopedDb = {} as DataContextDb;

const errorRow = {
  id: "error-1",
  owner_user_id: "user-a",
  occurred_at: new Date("2026-08-27T10:00:00.000Z"),
  feature: "news",
  operation: "refresh",
  error_category: "network",
  retryable: true,
  user_message: "News could not be refreshed.",
  internal_summary: "upstream timeout",
  request_id: "req-error"
} as MossErrorLog;

const actionRow = {
  id: "action-1",
  owner_user_id: "user-a",
  occurred_at: new Date("2026-08-27T10:01:00.000Z"),
  tool_module_id: "news",
  tool_name: "news.refreshNews",
  action_family_id: null,
  action_kind: "write",
  approval_mode: "confirmed",
  outcome: "success",
  error_class: null,
  request_id: "req-action",
  chat_session_id: null,
  turn_id: null,
  source_surface: "chat",
  input_summary: { userContent: "must not cross this boundary" },
  duration_ms: null
} as MossActionAuditLog;

describe("platform diagnostics service", () => {
  it("redacts runtime facts for non-admins and keeps the other sections actor-scoped", async () => {
    const listRecentErrors = vi.fn().mockResolvedValue([errorRow]);
    const listActionAuditLog = vi.fn().mockResolvedValue([actionRow]);
    const service = createPlatformDiagnosticsService({
      appMap: { getBuildInfo: () => ({ version: "1.2.3", buildId: "build-1" }) },
      collectHostDiagnostics: vi.fn(),
      repository: { listRecentErrors, listActionAuditLog },
      moduleProviders: async () => [],
      runInContext: async (work) => work({}),
      isInstanceAdmin: vi.fn().mockResolvedValue(false),
      assertDiagnosticsSafe: vi.fn()
    });

    const report = await service.observe(scopedDb, {
      actorUserId: "user-a",
      requestId: "req-1"
    });

    expect(report.runtime).toBeNull();
    expect(report.redactions).toEqual(["runtime"]);
    expect(report.build).toEqual({ version: "1.2.3", buildId: "build-1" });
    expect(report.errors).toEqual([
      {
        occurredAt: "2026-08-27T10:00:00.000Z",
        feature: "news",
        operation: "refresh",
        errorCategory: "network",
        retryable: true,
        userMessage: "News could not be refreshed.",
        internalSummary: "upstream timeout",
        requestId: "req-error"
      }
    ]);
    expect(JSON.stringify(report)).not.toContain("must not cross this boundary");
    expect(listRecentErrors).toHaveBeenCalledWith(scopedDb, { limit: 10, query: undefined });
    expect(listActionAuditLog).toHaveBeenCalledWith(
      scopedDb,
      expect.objectContaining({ limit: 10 })
    );
  });

  it("collects admin runtime facts and drops a provider that throws", async () => {
    const runtime = { version: "runtime" } as PlatformDiagnosticsReport["runtime"];
    const onProviderError = vi.fn();
    const service = createPlatformDiagnosticsService({
      appMap: { getBuildInfo: () => ({ version: "1.2.3", buildId: "build-1" }) },
      collectHostDiagnostics: vi.fn().mockResolvedValue(runtime),
      repository: {
        listRecentErrors: vi.fn().mockResolvedValue([]),
        listActionAuditLog: vi.fn().mockResolvedValue([])
      },
      moduleProviders: async () => [
        {
          moduleId: "good",
          provider: {
            domain: "news",
            providerId: "news.refresh",
            observe: async () => ({
              domain: "news",
              providerId: "news.refresh",
              observedAt: "2026-08-27T10:00:00.000Z",
              status: "ok" as const,
              summary: "News is current."
            })
          }
        },
        {
          moduleId: "broken",
          provider: {
            domain: "news",
            providerId: "news.broken",
            observe: async () => {
              const error = new Error("private provider details");
              error.name = "ProviderFailure";
              throw error;
            }
          }
        }
      ],
      runInContext: async (work) => work({}),
      isInstanceAdmin: vi.fn().mockResolvedValue(true),
      assertDiagnosticsSafe: vi.fn(),
      onProviderError
    });

    const report = await service.observe(
      scopedDb,
      {
        actorUserId: "admin",
        requestId: "req-1"
      },
      { domain: "news", include: ["runtime", "modules"], limit: 20 }
    );

    expect(report.runtime).toBe(runtime);
    expect(report.modules).toHaveLength(1);
    expect(onProviderError).toHaveBeenCalledWith("broken", "ProviderFailure");
    expect(JSON.stringify(onProviderError.mock.calls)).not.toContain("private provider details");
  });

  it("limits module observations to the requested result count", async () => {
    const service = createPlatformDiagnosticsService({
      appMap: { getBuildInfo: () => ({ version: "1.2.3", buildId: "build-1" }) },
      repository: {
        listRecentErrors: vi.fn().mockResolvedValue([]),
        listActionAuditLog: vi.fn().mockResolvedValue([])
      },
      moduleProviders: async () =>
        Array.from({ length: 11 }, (_, index) => ({
          moduleId: `module-${index}`,
          provider: {
            domain: "demo",
            providerId: `demo.${index}`,
            observe: async () => ({
              domain: "demo",
              providerId: `demo.${index}`,
              observedAt: "2026-08-27T10:00:00.000Z",
              status: "ok" as const,
              summary: "Everything is fine."
            })
          }
        })),
      runInContext: async (work) => work({}),
      isInstanceAdmin: vi.fn().mockResolvedValue(false),
      assertDiagnosticsSafe: vi.fn()
    });

    const report = await service.observe(
      scopedDb,
      { actorUserId: "user-a", requestId: "req-1" },
      { include: ["modules"], limit: 10 }
    );

    expect(report.modules).toHaveLength(10);
  });

  it("uses the bounded source inspector only for an explicit source request", async () => {
    const source = {
      matches: [{ path: "packages/news/src/jobs.ts", startLine: 1, endLine: 1, text: "news" }],
      filesScanned: 1,
      truncated: false,
      rejected: []
    };
    const search = vi.fn().mockResolvedValue(source);
    const service = createPlatformDiagnosticsService({
      appMap: { getBuildInfo: () => ({ version: "1.2.3", buildId: "build-1" }) },
      sourceInspector: { search },
      repository: {
        listRecentErrors: vi.fn().mockResolvedValue([]),
        listActionAuditLog: vi.fn().mockResolvedValue([])
      },
      moduleProviders: async () => [],
      runInContext: async (work) => work({}),
      isInstanceAdmin: vi.fn().mockResolvedValue(false),
      assertDiagnosticsSafe: vi.fn()
    });

    const report = await service.observe(
      scopedDb,
      { actorUserId: "user-a", requestId: "req-1" },
      { include: ["source"], query: "news", limit: 2 }
    );

    expect(report.source).toBe(source);
    expect(search).toHaveBeenCalledWith({ query: "news", limit: 2 });
  });

  describe("admin-only jobs and connections", () => {
    const jobsSection = {
      recent: [
        {
          occurredAt: "2026-08-27T10:00:00.000Z",
          queue: "connectors.sync",
          state: "failed",
          retryCount: 2,
          ownerKnown: true,
          kind: "sync",
          connectorAccountId: null,
          errorLabel: "failed"
        }
      ],
      summaries: [],
      truncated: false
    };
    const connectionsSection = {
      items: [
        {
          provider: "google",
          accountId: "acct-1",
          status: "error",
          lastAttemptAt: "2026-08-27T10:00:00.000Z",
          lastGoodAt: null,
          failureCount: 1,
          errorLabel: "sync-failed"
        }
      ],
      truncated: false
    };

    function build(options: {
      isInstanceAdmin: () => Promise<boolean>;
      readJobs?: ReturnType<typeof vi.fn>;
      readConnections?: ReturnType<typeof vi.fn>;
    }) {
      return createPlatformDiagnosticsService({
        appMap: { getBuildInfo: () => ({ version: "1.2.3", buildId: "build-1" }) },
        repository: {
          listRecentErrors: vi.fn().mockResolvedValue([]),
          listActionAuditLog: vi.fn().mockResolvedValue([])
        },
        moduleProviders: async () => [],
        runInContext: async (work) => work({}),
        isInstanceAdmin: options.isInstanceAdmin,
        assertDiagnosticsSafe: vi.fn(),
        readJobs: options.readJobs,
        readConnections: options.readConnections
      });
    }

    const ctx = { actorUserId: "user-a", requestId: "req-1" };
    const both = { include: ["jobs", "connections"] as const };

    it("returns empty sections and redactions to a non-admin without reading", async () => {
      const readJobs = vi.fn().mockResolvedValue(jobsSection);
      const readConnections = vi.fn().mockResolvedValue(connectionsSection);
      const service = build({
        isInstanceAdmin: async () => false,
        readJobs,
        readConnections
      });
      const report = await service.observe(scopedDb, ctx, both);
      expect(report.redactions).toEqual(["jobs", "connections"]);
      expect(report.jobs).toEqual({ recent: [], summaries: [], truncated: false });
      expect(report.connections).toEqual({ items: [], truncated: false });
      expect(readJobs).not.toHaveBeenCalled();
      expect(readConnections).not.toHaveBeenCalled();
    });

    it("gives an admin both sections and passes the actor and a 24 hour window", async () => {
      const readJobs = vi.fn().mockResolvedValue(jobsSection);
      const readConnections = vi.fn().mockResolvedValue(connectionsSection);
      const service = build({ isInstanceAdmin: async () => true, readJobs, readConnections });
      const report = await service.observe(scopedDb, ctx, both);
      expect(report.jobs).toEqual(jobsSection);
      expect(report.connections).toEqual(connectionsSection);
      expect(report.redactions).toEqual([]);
      expect(readJobs).toHaveBeenCalledWith(
        scopedDb,
        ctx,
        expect.objectContaining({ limit: 10, since: expect.any(Date) })
      );
    });

    it("leaves the sections out unless asked, so default calls are unchanged", async () => {
      const readJobs = vi.fn();
      const service = build({ isInstanceAdmin: async () => true, readJobs });
      const report = await service.observe(scopedDb, ctx);
      expect(readJobs).not.toHaveBeenCalled();
      expect(report.jobs.recent).toEqual([]);
      expect(report.redactions).not.toContain("jobs");
    });

    it("redacts a section whose reader is not wired", async () => {
      const service = build({ isInstanceAdmin: async () => true });
      const report = await service.observe(scopedDb, ctx, both);
      expect(report.redactions).toEqual(["jobs", "connections"]);
    });

    it("checks admin status live on every call, so a demotion takes effect", async () => {
      const isInstanceAdmin = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const readJobs = vi.fn().mockResolvedValue(jobsSection);
      const service = build({ isInstanceAdmin, readJobs });
      const first = await service.observe(scopedDb, ctx, { include: ["jobs"] });
      const second = await service.observe(scopedDb, ctx, { include: ["jobs"] });
      expect(first.jobs.recent).toHaveLength(1);
      expect(second.jobs.recent).toEqual([]);
      expect(second.redactions).toEqual(["jobs"]);
      expect(isInstanceAdmin).toHaveBeenCalledTimes(2);
      expect(readJobs).toHaveBeenCalledTimes(1);
    });

    it("refuses a missing identity before any read", async () => {
      const readJobs = vi.fn();
      const isInstanceAdmin = vi.fn().mockResolvedValue(true);
      const service = build({ isInstanceAdmin, readJobs });
      await expect(
        service.observe(scopedDb, { actorUserId: "", requestId: "r" }, both)
      ).rejects.toThrow("actor");
      expect(readJobs).not.toHaveBeenCalled();
      expect(isInstanceAdmin).not.toHaveBeenCalled();
    });

    it("drops items from the end of an oversized section and flags it", async () => {
      const big = Array.from({ length: 10 }, (_, i) => ({
        ...jobsSection.recent[0]!,
        queue: `queue-${i}-${"x".repeat(100)}`,
        kind: "k".repeat(120),
        connectorAccountId: "c".repeat(120),
        errorLabel: "e".repeat(120)
      }));
      const summaries = Array.from({ length: 10 }, (_, i) => ({
        queue: `q${i}-${"y".repeat(100)}`,
        lastSuccessAt: null,
        lastFailureAt: null,
        failedLast24h: 1,
        stuckCount: 0,
        activeCount: 0
      }));
      const items = Array.from({ length: 10 }, (_, i) => ({
        ...connectionsSection.items[0]!,
        provider: "p".repeat(120),
        accountId: `${i}-${"a".repeat(120)}`
      }));
      const service = build({
        isInstanceAdmin: async () => true,
        readJobs: vi.fn().mockResolvedValue({
          recent: big.concat(big),
          summaries: summaries.concat(summaries),
          truncated: false
        }),
        readConnections: vi.fn().mockResolvedValue({ items, truncated: false })
      });
      const report = await service.observe(scopedDb, ctx, both);
      expect(report.jobs.truncated).toBe(true);
      expect(report.jobs.recent.length).toBeLessThanOrEqual(10);
      expect(JSON.stringify(report.jobs).length).toBeLessThanOrEqual(16 * 1024);
      expect(JSON.stringify(report.connections).length).toBeLessThanOrEqual(16 * 1024);
      expect(report.jobs.recent[0]?.queue).toBe(big[0]!.queue);
    });
  });
});

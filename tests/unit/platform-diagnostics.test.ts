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
});

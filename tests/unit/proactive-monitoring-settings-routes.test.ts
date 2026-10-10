import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { defaultProactiveMonitoringPreference } from "@moss/shared";
import { ProactivePreferenceRevisionConflictError } from "@moss/proactive-monitoring";
import {
  PROACTIVE_SETTINGS_CONFLICT_MESSAGE,
  registerProactiveMonitoringSettingsRoutes
} from "@moss/settings";

function routeHarness(saved: unknown, revision = 4) {
  const initialized =
    saved === undefined
      ? {
          raw: { version: 1, automaticEmailAlerts: true },
          preference: { ...defaultProactiveMonitoringPreference(), automaticEmailAlerts: true },
          hasLegacyEmailChoice: false
        }
      : saved;
  const repository = {
    get: vi.fn().mockResolvedValue(defaultProactiveMonitoringPreference()),
    getSaved: vi.fn().mockResolvedValue(saved),
    getSavedWithRevision: vi
      .fn()
      .mockResolvedValue(saved === undefined ? undefined : { saved, revision }),
    initializeAutomaticEmailAlerts: vi.fn().mockResolvedValue(initialized),
    upsertWithRevision: vi.fn().mockImplementation(async (_db, raw: Record<string, unknown>) => ({
      raw,
      revision: revision + 1,
      preference: {
        ...defaultProactiveMonitoringPreference(),
        ...raw,
        sources: {
          ...defaultProactiveMonitoringPreference().sources,
          ...(raw.sources as Record<string, unknown> | undefined)
        },
        quietHours: {
          ...defaultProactiveMonitoringPreference().quietHours,
          ...(raw.quietHours as Record<string, unknown> | undefined)
        }
      },
      hasLegacyEmailChoice: "enabled" in raw || "email" in ((raw.sources as object) ?? {})
    }))
  };
  const app = Fastify();
  registerProactiveMonitoringSettingsRoutes(app, {
    dataContext: {
      withDataContext: async (_ctx: unknown, fn: (db: never) => unknown) => fn({} as never)
    } as never,
    resolveAccessContext: async () => ({ actorUserId: "00000000-0000-4000-8000-0000000000a1" }),
    repository: repository as never
  });
  return { app, repository };
}

describe("proactive monitoring settings persistence", () => {
  it("writes an email-only first save without manufacturing quiet-hours or legacy intent", async () => {
    const { app, repository } = routeHarness(undefined);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/proactive-monitoring-settings",
      payload: { automaticEmailAlerts: true }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.upsertWithRevision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ version: 1, automaticEmailAlerts: true }),
      null
    );
    const saved = vi.mocked(repository.upsertWithRevision).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(saved).not.toHaveProperty("quietHours");
    expect(saved).not.toHaveProperty("sources");
    expect(saved).not.toHaveProperty("enabled");
    await app.close();
  });

  it("fails closed without overwriting a malformed saved record", async () => {
    const { app, repository } = routeHarness(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/me/proactive-monitoring-settings"
    });
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/me/proactive-monitoring-settings",
      payload: { automaticEmailAlerts: true }
    });

    expect(response.statusCode).toBe(409);
    expect(patch.statusCode).toBe(409);
    expect(repository.upsertWithRevision).not.toHaveBeenCalled();
    await app.close();
  });

  it("patches a legacy record without changing its unrelated quiet-hours values", async () => {
    const legacy = {
      raw: {
        ...defaultProactiveMonitoringPreference(),
        quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" }
      },
      preference: {
        ...defaultProactiveMonitoringPreference(),
        quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" }
      },
      hasLegacyEmailChoice: true
    };
    const { app, repository } = routeHarness(legacy);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/proactive-monitoring-settings",
      payload: { automaticEmailAlerts: false }
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(repository.upsertWithRevision).mock.calls[0]?.[1]).toMatchObject({
      quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" },
      automaticEmailAlerts: false
    });
    await app.close();
  });

  it("keeps a legacy source cap when the existing caller patches only enabled", async () => {
    const pref = {
      ...defaultProactiveMonitoringPreference(),
      sources: {
        ...defaultProactiveMonitoringPreference().sources,
        email: { enabled: false, dailyCardCap: 2 }
      }
    };
    const { app, repository } = routeHarness({
      raw: { ...pref },
      preference: pref,
      hasLegacyEmailChoice: true
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/proactive-monitoring-settings",
      payload: { sources: { email: { enabled: true } } }
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(repository.upsertWithRevision).mock.calls[0]?.[1]).toMatchObject({
      sources: { email: { enabled: true, dailyCardCap: 2 } }
    });
    await app.close();
  });

  it("locks the row and writes against the revision it read", async () => {
    const { app, repository } = routeHarness(legacyRecord(), 7);
    const response = await patch(app, { automaticEmailAlerts: false });

    expect(response.statusCode).toBe(200);
    expect(repository.getSavedWithRevision).toHaveBeenCalledWith(expect.anything(), {
      forUpdate: true
    });
    expect(vi.mocked(repository.upsertWithRevision).mock.calls[0]?.[2]).toBe(7);
    await app.close();
  });

  it("re-reads and merges again after a concurrent write, then refuses once retries run out", async () => {
    const retried = routeHarness(legacyRecord());
    vi.mocked(retried.repository.upsertWithRevision).mockRejectedValueOnce(
      new ProactivePreferenceRevisionConflictError()
    );
    expect((await patch(retried.app, { automaticEmailAlerts: false })).statusCode).toBe(200);
    expect(retried.repository.getSavedWithRevision).toHaveBeenCalledTimes(2);
    await retried.app.close();

    const exhausted = routeHarness(legacyRecord());
    vi.mocked(exhausted.repository.upsertWithRevision).mockRejectedValue(
      new ProactivePreferenceRevisionConflictError()
    );
    const response = await patch(exhausted.app, { automaticEmailAlerts: false });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: PROACTIVE_SETTINGS_CONFLICT_MESSAGE });
    expect(exhausted.repository.upsertWithRevision).toHaveBeenCalledTimes(3);
    await exhausted.app.close();
  });

  it("rejects a newly supplied quiet time outside 00:00-23:59 without writing", async () => {
    const { app, repository } = routeHarness(legacyRecord());
    const response = await patch(app, { quietHours: { startLocalTime: "24:30" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "quietHours.startLocalTime must be HH:MM (00:00-23:59)"
    });
    expect(repository.upsertWithRevision).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a newly supplied window that starts and ends at the same time", async () => {
    const { app, repository } = routeHarness(legacyRecord());
    const response = await patch(app, { quietHours: { endLocalTime: "21:00" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Quiet hours must start and end at different times"
    });
    expect(repository.upsertWithRevision).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts an overnight window", async () => {
    const { app, repository } = routeHarness(legacyRecord());
    const response = await patch(app, {
      quietHours: { startLocalTime: "23:15", endLocalTime: "05:45" }
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(repository.upsertWithRevision).mock.calls[0]?.[1]).toMatchObject({
      quietHours: { enabled: true, startLocalTime: "23:15", endLocalTime: "05:45" }
    });
    await app.close();
  });

  it("keeps a saved legacy out-of-range time when an unrelated quiet field changes", async () => {
    const { app, repository } = routeHarness(
      legacyRecord({ enabled: true, startLocalTime: "25:00", endLocalTime: "25:00" })
    );
    const response = await patch(app, {
      quietHours: { enabled: false, startLocalTime: "25:00" }
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(repository.upsertWithRevision).mock.calls[0]?.[1]).toMatchObject({
      quietHours: { enabled: false, startLocalTime: "25:00", endLocalTime: "25:00" }
    });
    await app.close();
  });
});

function legacyRecord(
  quietHours = { enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" }
) {
  return {
    raw: { ...defaultProactiveMonitoringPreference(), quietHours },
    preference: { ...defaultProactiveMonitoringPreference(), quietHours },
    hasLegacyEmailChoice: true
  };
}

function patch(app: ReturnType<typeof Fastify>, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: "/api/me/proactive-monitoring-settings", payload });
}

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { defaultProactiveMonitoringPreference } from "@moss/shared";
import { registerProactiveMonitoringSettingsRoutes } from "@moss/settings";

function routeHarness(saved: unknown) {
  const repository = {
    get: vi.fn().mockResolvedValue(defaultProactiveMonitoringPreference()),
    getSaved: vi.fn().mockResolvedValue(saved),
    upsert: vi.fn().mockImplementation(async (_db, raw: Record<string, unknown>) => ({
      raw,
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
    expect(repository.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ version: 1, automaticEmailAlerts: true })
    );
    const saved = vi.mocked(repository.upsert).mock.calls[0]?.[1] as Record<string, unknown>;
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
    expect(repository.upsert).not.toHaveBeenCalled();
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
    expect(vi.mocked(repository.upsert).mock.calls[0]?.[1]).toMatchObject({
      quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" },
      automaticEmailAlerts: false
    });
    await app.close();
  });
});

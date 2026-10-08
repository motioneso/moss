import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createSessionBindingsService } from "../../packages/auth/src/session-bindings.js";
const actorUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("auth-owned session bindings", () => {
  it("never accepts a bearer as cookie approval or reads cookie token bytes from storage", async () => {
    const query = vi.fn(async (_query: string, _parameters?: unknown[]) => ({
      rows: [{ expires_at: new Date(Date.now() + 10000) }]
    }));
    const getSession = vi.fn(async () => ({
      user: { id: actorUserId },
      session: { id: sessionId }
    }));
    const service = createSessionBindingsService({
      pool: { query } as unknown as pg.Pool,
      auth: { api: { getSession } }
    });
    await expect(
      service.resolveBrowser({
        headers: { authorization: "Bearer synthetic", cookie: "session=synthetic" },
        requestId: "request"
      })
    ).rejects.toThrow();
    expect(getSession).not.toHaveBeenCalled();
    expect(
      await service.resolveBrowser({
        headers: { cookie: "session=synthetic" },
        requestId: "request"
      })
    ).toMatchObject({ actorUserId, sessionId });
    expect(query.mock.calls[0]?.[0]).toContain("s.expires_at");
    expect(query.mock.calls[0]?.[0]).not.toContain("s.token");
  });
  it("freshly rejects deleted cookie/device bindings and checks active account scope", async () => {
    const query = vi.fn(async (_query: string, _parameters?: unknown[]) => ({ rows: [] }));
    const service = createSessionBindingsService({
      pool: { query } as unknown as pg.Pool,
      auth: { api: { getSession: vi.fn() } }
    });
    await expect(service.assertLive({ actorUserId, sessionId })).rejects.toThrow();
    await expect(service.assertLive({ actorUserId, deviceId: sessionId })).rejects.toThrow();
    for (const call of query.mock.calls) {
      expect(call[0]).toContain("u.status='active'");
      expect(call[1]).toContain(actorUserId);
    }
  });
});

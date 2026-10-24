import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { SessionInvalidations } from "../../packages/auth/src/session-invalidations.js";
import { createMeSessionsService } from "../../packages/auth/src/session-service.js";
import { createBetterAuthOptions } from "../../packages/auth/src/index.js";
import { betterAuth } from "../../packages/auth/node_modules/better-auth/dist/index.mjs";
import { memoryAdapter } from "../../packages/auth/node_modules/better-auth/dist/adapters/memory-adapter/index.mjs";
import { authFixture, binding, deferred, OWNER, SESSION } from "./computer-auth-fixture.js";

function sessionFixture() {
  const pool = new pg.Pool();
  const query = vi.spyOn(pool, "query").mockImplementation(async () => ({
    rows: [],
    rowCount: 1,
    command: "DELETE",
    oid: 0,
    fields: []
  }));
  const source = new SessionInvalidations();
  const events = vi.fn();
  source.subscribe(events);
  const service = createMeSessionsService({
    pool,
    sessionInvalidations: source,
    auth: { api: { getSession: async () => ({ session: { id: SESSION } }) } }
  });
  return { pool, query, source, events, service };
}

describe("auth-owned active session invalidations", () => {
  it("completion push retires a new binding registered while revokeOne DELETE is held", async () => {
    const f = await authFixture();
    const pool = new pg.Pool();
    const held = deferred();
    const started = deferred();
    const target = "40000000-0000-4000-8000-000000000004";
    vi.spyOn(pool, "query").mockImplementation(async () => {
      started.resolve();
      await held.promise;
      return { rows: [], rowCount: 1, command: "DELETE", oid: 0, fields: [] };
    });
    const service = createMeSessionsService({
      pool,
      sessionInvalidations: f.invalidations,
      auth: { api: { getSession: async () => ({ session: { id: SESSION } }) } }
    });
    try {
      const operation = service.revokeOne({ actorUserId: OWNER, sessionId: target, headers: {} });
      await started.promise;
      const lost = vi.fn();
      const raced = await f.connect(binding(target), lost);
      held.resolve();
      await operation;
      await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1), { timeout: 1000 });
      await expect(raced.assertLive({ actorUserId: OWNER, sessionId: target })).rejects.toThrow();
    } finally {
      held.resolve();
      await f.close();
      await pool.end();
    }
  });
  it("scopes revokeOne notifications, refuses current-session revocation and notifies on query failure", async () => {
    const f = sessionFixture();
    const other = "40000000-0000-4000-8000-000000000004";
    try {
      expect(
        await f.service.revokeOne({ actorUserId: OWNER, sessionId: SESSION, headers: {} })
      ).toEqual({ revoked: false, wasCurrent: true });
      expect(f.events).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
      await f.service.revokeOne({ actorUserId: OWNER, sessionId: other, headers: {} });
      expect(f.events.mock.calls.map(([event]) => event)).toEqual([
        { actorUserId: OWNER, sessionId: other },
        { actorUserId: OWNER, sessionId: other }
      ]);
      expect(f.query).toHaveBeenCalledWith(
        "DELETE FROM app.better_auth_sessions WHERE id = $1 AND user_id = $2",
        [other, OWNER]
      );
      f.events.mockClear();
      f.query.mockRejectedValueOnce(new Error("database unavailable"));
      await expect(
        f.service.revokeOne({ actorUserId: OWNER, sessionId: other, headers: {} })
      ).rejects.toThrow();
      expect(f.events).toHaveBeenCalledTimes(2);
    } finally {
      await f.pool.end();
    }
  });

  it("notifies revokeOthers before and after a held delete, preserving the current session exception", async () => {
    const f = sessionFixture();
    const held = deferred();
    const started = deferred();
    f.query.mockImplementationOnce(async () => {
      started.resolve();
      await held.promise;
      return { rows: [], rowCount: 1, command: "DELETE", oid: 0, fields: [] };
    });
    try {
      const result = f.service.revokeOthers({ actorUserId: OWNER, headers: {} });
      await started.promise;
      expect(f.events).toHaveBeenCalledExactlyOnceWith({
        actorUserId: OWNER,
        exceptSessionId: SESSION
      });
      held.resolve();
      expect(await result).toBe(3);
      expect(f.events.mock.calls.map(([event]) => event)).toEqual([
        { actorUserId: OWNER, exceptSessionId: SESSION },
        { actorUserId: OWNER, exceptSessionId: SESSION }
      ]);
    } finally {
      held.resolve();
      await f.pool.end();
    }
  });

  it("bounds subscriptions and one failing listener cannot skip another or interrupt logout", () => {
    const source = new SessionInvalidations();
    source.subscribe(() => {
      throw new Error("listener failed");
    });
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    source.invalidate({ actorUserId: OWNER, sessionId: SESSION });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ actorUserId: OWNER, sessionId: SESSION });
    unsubscribe();
    source.invalidate({ actorUserId: OWNER });
    expect(listener).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 16; i++) source.subscribe(() => {});
    expect(() => source.subscribe(() => {})).toThrow();
    source.close();
    expect(() => source.subscribe(() => {})).toThrow();
  });

  it("real Better Auth signOut reaches both session hooks and never projects its token", async () => {
    const source = new SessionInvalidations();
    const events = vi.fn();
    source.subscribe(events);
    const options = createBetterAuthOptions(
      {} as never,
      {} as never,
      {
        JARVIS_AUTH_SECRET: "synthetic-unit-test-secret-at-least-thirty-two-bytes",
        MOSS_AUTH_BASE_URL: "http://localhost:3000"
      },
      {} as never,
      { recordBootstrapOwnerAuditEvent: async () => {}, recordAuditEvent: async () => {} },
      undefined,
      source
    );
    const store = {
      users: [],
      better_auth_sessions: [],
      auth_accounts: [],
      auth_verifications: []
    };
    const auth = betterAuth({
      ...options,
      database: memoryAdapter(store),
      databaseHooks: { session: options.databaseHooks?.session }
    });
    const signup = await auth.api.signUpEmail({
      body: {
        name: "Synthetic",
        email: "synthetic@example.test",
        password: "synthetic-password-only"
      },
      asResponse: true
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");
    const resolved = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(resolved?.session.id).toBeTruthy();
    const response = await auth.api.signOut({ headers: new Headers({ cookie }), asResponse: true });
    expect(response.status).toBe(200);
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { actorUserId: resolved!.user.id, sessionId: resolved!.session.id },
      { actorUserId: resolved!.user.id, sessionId: resolved!.session.id }
    ]);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    // Assertions compare only the projection: the vendor session row also contains a token.
    expect(Object.keys(events.mock.calls[0]![0]).sort()).toEqual(["actorUserId", "sessionId"]);
    source.close();
  });
});

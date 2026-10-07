import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { registerRouteEnablementGuard } from "@moss/module-registry";
import type { MossModuleManifest } from "@moss/module-sdk";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

function cookieHeader(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

describe("module enablement endpoints", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let ownerCookie: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    const signUp = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Owner",
        email: "owner@example.test",
        password: "correct horse battery staple"
      }
    });
    ownerCookie = cookieHeader(signUp.headers as Record<string, unknown>);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("GET /api/admin/modules lists every built-in with required + instanceDisabled flags", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/modules",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      modules: { id: string; required: boolean; instanceDisabled: boolean }[];
    }>();
    const tasks = body.modules.find((m) => m.id === "tasks");
    expect(tasks?.required).toBe(true);
    expect(tasks?.instanceDisabled).toBe(false);
    expect(body.modules.length).toBeGreaterThanOrEqual(11);
  });

  it("admin disabling a required module is rejected with 409", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/modules/tasks",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { disabled: true }
    });
    expect(res.statusCode).toBe(409);
  });

  it("admin disabling an unknown module is 404", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/modules/does-not-exist",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { disabled: true }
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/me/modules returns active flags for the caller", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/modules",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ modules: { id: string; active: boolean }[] }>();
    expect(body.modules.every((m) => m.active)).toBe(true);
  });

  it("self disabling a required module is 409", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/me/modules/tasks",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { disabled: true }
    });
    expect(res.statusCode).toBe(409);
  });

  it("a non-admin actor cannot reach the admin endpoint", async () => {
    // Register a second, non-admin user (requires_approval is off so they are active).
    const signUp = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Member",
        email: "member@example.test",
        password: "correct horse battery staple x"
      }
    });
    const memberCookie = cookieHeader(signUp.headers as Record<string, unknown>);
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/modules",
      headers: { cookie: memberCookie }
    });
    expect(res.statusCode).toBe(403);
  });

  it("a non-admin PATCH gets 403 even for an unknown or required module (no existence leak)", async () => {
    // Re-register a non-admin member (cookies above are scoped to other tests).
    const signUp = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        name: "Member2",
        email: "member2@example.test",
        password: "correct horse battery staple y"
      }
    });
    const memberCookie = cookieHeader(signUp.headers as Record<string, unknown>);
    // Unknown module: an admin would get 404, a required module 409 — a non-admin must
    // get 403 for BOTH, so the response cannot be used to probe module existence/status.
    const unknown = await server.inject({
      method: "PATCH",
      url: "/api/admin/modules/does-not-exist",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { disabled: true }
    });
    expect(unknown.statusCode).toBe(403);
    const required = await server.inject({
      method: "PATCH",
      url: "/api/admin/modules/tasks",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { disabled: true }
    });
    expect(required.statusCode).toBe(403);
  });

  describe("route guard wiring (real server)", () => {
    it("the real server boots clean (coverage assertion passes)", async () => {
      // server.ready() in beforeAll already ran the boot assertion; reaching here proves it.
      expect(server).toBeDefined();
    });

    it("platform routes are never 404'd by the guard", async () => {
      for (const url of ["/api/me", "/api/modules", "/api/me/modules", "/health"]) {
        const res = await server.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
        expect(res.statusCode).not.toBe(404);
      }
    });

    it("an active module's route is reachable (not guard-404'd)", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/tasks",
        headers: { cookie: ownerCookie }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("real server route-enablement guard is wired", () => {
    it("fails boot for an injected route without a chat policy", async () => {
      const probe = createApiServer({
        appDb,
        boss,
        logger: false,
        __testExtraGuardedRoutes: {
          manifests: [
            {
              id: "__chat_policy_probe__",
              name: "Chat policy probe",
              version: "0.1.0",
              publisher: "test",
              lifecycle: "optional",
              compatibility: { jarv1s: ">=0.0.0" },
              routes: [{ method: "GET", path: "/api/__chat_policy_probe__" }]
            }
          ],
          routes: [{ method: "GET", url: "/api/__chat_policy_probe__" }]
        }
      });
      try {
        await expect(probe.ready()).rejects.toThrow(
          /GET \/api\/__chat_policy_probe__.*no chat access/
        );
      } finally {
        await probe.close();
      }
    });

    it("404s a route owned by an inactive (synthetic) module — proving the guard is registered", async () => {
      const probeDb = createDatabase({
        connectionString: connectionStrings.app,
        maxConnections: 1
      });
      // #1124: give this one-off probe server its own explicit boss with a longer
      // connectionTimeoutMillis, same rationale as the shared server above (test-only).
      const probeBoss = createPgBossClient(connectionStrings.app, {
        connectionTimeoutMillis: 25_000
      });
      const probeServer = createApiServer({
        appDb: probeDb,
        boss: probeBoss,
        logger: false,
        __testExtraGuardedRoutes: {
          manifests: [
            {
              id: "__probe_inactive__",
              name: "Probe",
              version: "0.1.0",
              publisher: "test",
              lifecycle: "optional",
              compatibility: { jarv1s: ">=0.0.0" },
              availability: { defaultEnabled: true, required: false, supportsUserDisable: true },
              routes: [
                {
                  method: "GET",
                  path: "/api/__probe__/ping",
                  permissionId: "probe.view",
                  chat: { access: "read", content: "user_authored" }
                }
              ]
            }
          ],
          routes: [{ method: "GET", url: "/api/__probe__/ping" }]
        }
      });
      await probeServer.ready();
      // Authenticated request (reuse the signed-in owner cookie). The guard resolves the
      // actor, finds /api/__probe__/ping → module "__probe_inactive__", which the resolver
      // (built-ins only) never returns active → 404. Before the guard is wired: 200.
      const res = await probeServer.inject({
        method: "GET",
        url: "/api/__probe__/ping",
        headers: { cookie: ownerCookie }
      });
      expect(res.statusCode).toBe(404);
      await probeServer.close();
      await probeDb.destroy();
      await probeBoss.stop({ graceful: false });
    });
  });
});

describe("registerRouteEnablementGuard end-to-end (bare Fastify)", () => {
  const weather: MossModuleManifest = {
    id: "weather",
    name: "Weather",
    version: "0.1.0",
    publisher: "test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true, required: false, supportsUserDisable: true },
    routes: [{ method: "GET", path: "/api/weather/today", permissionId: "weather.view" }]
  };

  async function buildServer(active: boolean) {
    const app = Fastify({ logger: false });
    app.after(() => {
      app.get("/api/weather/today", async () => ({ ok: true }));
      registerRouteEnablementGuard(app, {
        manifests: [weather],
        resolveActiveModules: async () => (active ? [weather] : []),
        resolveAccessContext: async () => ({
          actorUserId: "00000000-0000-4000-8000-000000000001"
        }),
        platformAllowlist: new Set<string>()
      });
    });
    await app.ready();
    return app;
  }

  it("returns 200 when the module is active", async () => {
    const app = await buildServer(true);
    const res = await app.inject({ method: "GET", url: "/api/weather/today" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 404 (NOT 403) when the module is not active", async () => {
    const app = await buildServer(false);
    const res = await app.inject({ method: "GET", url: "/api/weather/today" });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it("never 404s a CORS preflight: OPTIONS passes the guard even for a disabled module", async () => {
    // An OPTIONS preflight keys as "OPTIONS /api/weather/today" — on neither the platform
    // allowlist nor the manifest routes[], so before the short-circuit the guard 404'd it
    // even though the module is INACTIVE. That would break cross-origin preflight (e.g.
    // /api/auth/*) the moment Phase 2 adds a containerized/--host topology. The guard must
    // let OPTIONS through so the route's own OPTIONS handler (or @fastify/cors) can answer.
    const app = Fastify({ logger: false });
    let actorResolved = false;
    app.after(() => {
      // Register an explicit OPTIONS handler so Fastify has a matched route to answer with.
      app.options("/api/weather/today", async (_req, reply) => reply.code(204).send());
      app.get("/api/weather/today", async () => ({ ok: true }));
      registerRouteEnablementGuard(app, {
        manifests: [weather],
        // Module is INACTIVE: a guarded verb (GET) would 404. OPTIONS must still pass.
        resolveActiveModules: async () => [],
        resolveAccessContext: async () => {
          // The guard must short-circuit OPTIONS BEFORE any actor resolution.
          actorResolved = true;
          return { actorUserId: "00000000-0000-4000-8000-000000000001" };
        },
        platformAllowlist: new Set<string>()
      });
    });
    await app.ready();
    const res = await app.inject({ method: "OPTIONS", url: "/api/weather/today" });
    expect(res.statusCode).toBe(204);
    expect(res.statusCode).not.toBe(404);
    // The short-circuit happens before access-context resolution, so it is also cheap.
    expect(actorResolved).toBe(false);
    await app.close();
  });

  it("FAILS CLOSED: a resolver throw never reaches the route handler", async () => {
    // A resolver/DB error must NEVER silently let a guarded request through (which would
    // re-enable a disabled module). The thrown error becomes a 503 via the guard's
    // fail-closed branch; the handler body must not run. We prove it both by status (not
    // 200) and by a side-effect flag the handler would set if it ran.
    const app = Fastify({ logger: false });
    let handlerRan = false;
    app.after(() => {
      app.get("/api/weather/today", async () => {
        handlerRan = true;
        return { ok: true };
      });
      registerRouteEnablementGuard(app, {
        manifests: [weather],
        resolveActiveModules: async () => {
          throw new Error("resolver/DB unavailable");
        },
        resolveAccessContext: async () => ({
          actorUserId: "00000000-0000-4000-8000-000000000001"
        }),
        platformAllowlist: new Set<string>()
      });
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/weather/today" });
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBe(503);
    expect(handlerRan).toBe(false);
    // The internal error message must NOT leak in the response body.
    expect(res.body).not.toContain("resolver/DB unavailable");
    await app.close();
  });
});

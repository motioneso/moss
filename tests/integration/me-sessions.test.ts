import { createHash } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { ListMySessionsResponse } from "@moss/shared";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  connectionStrings,
  ids,
  resetEmptyFoundationDatabase,
  resetFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

// #237 — current-user active session list/revoke. Exercised over the legacy bearer auth path
// (Authorization: Bearer <auth_sessions.id>), so the request's current session is `ids.sessionA`
// in app.auth_sessions; cookie sessions live in app.better_auth_sessions. Both must be listed
// and revocable, never leaking a secret, never crossing user boundaries.
//
// SECURITY: app.auth_sessions.id IS the bearer token secret (migration 0046). The API must emit
// a one-way handle (sha256(id)) for bearer rows, never the raw id, and resolve that handle back
// to the real id under actor scope to revoke.
describe("#237 current-user active sessions", () => {
  // Cookie (better_auth_sessions) fixtures — id is a non-secret row id.
  const cookieA1 = "50000000-0000-4000-8000-0000000000a1";
  const cookieA2 = "50000000-0000-4000-8000-0000000000a2";
  const cookieAExpired = "50000000-0000-4000-8000-0000000000a3";
  const cookieB1 = "50000000-0000-4000-8000-0000000000b1";
  // Extra NON-current bearer session for user A (auth_sessions.id is itself the secret).
  const bearerA2 = "40000000-0000-4000-8000-0000000000a2";
  // Linked Macs (#2560). The row id is non-secret; the credential exists only as a hash.
  const macA1 = "52000000-0000-4000-8000-0000000000a1";
  const macAExpired = "52000000-0000-4000-8000-0000000000a2";
  const macB1 = "52000000-0000-4000-8000-0000000000b1";
  // Token secrets — these must NEVER appear in any API response.
  const tokens = {
    a1: "tok-a1-SECRET-must-not-leak",
    a2: "tok-a2-SECRET-must-not-leak",
    aExpired: "tok-aexp-SECRET-must-not-leak",
    b1: "tok-b1-SECRET-must-not-leak"
  };

  // Public handle the API exposes for a bearer session (must match the service implementation).
  const handle = (realId: string) => createHash("sha256").update(realId).digest("hex");
  const handleSessionA = handle(ids.sessionA);
  const handleBearerA2 = handle(bearerA2);
  const handleSessionB = handle(ids.sessionB);

  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  const asUserA = (method: "GET" | "DELETE", url: string) =>
    server.inject({ method, url, headers: { authorization: `Bearer ${ids.sessionA}` } });

  async function withBootstrap<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function seedSessions(): Promise<void> {
    await withBootstrap(async (client) => {
      await client.query("DELETE FROM app.better_auth_sessions");
      await client.query(
        `INSERT INTO app.better_auth_sessions
           (id, user_id, token, expires_at, created_at, updated_at, ip_address, user_agent)
         VALUES
           ($1,  $2, $3,  now() + interval '1 day', now() - interval '2 hours', now() - interval '5 minutes',
            '203.0.113.7', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36'),
           ($4,  $2, $5,  now() + interval '1 day', now() - interval '1 day', now() - interval '1 day',
            '198.51.100.4', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari'),
           ($6,  $2, $7,  now() - interval '1 hour', now() - interval '2 days', now() - interval '2 days',
            NULL, NULL),
           ($8,  $9, $10, now() + interval '1 day', now(), now(),
            NULL, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36')`,
        [
          cookieA1,
          ids.userA,
          tokens.a1,
          cookieA2,
          tokens.a2,
          cookieAExpired,
          tokens.aExpired,
          cookieB1,
          ids.userB,
          tokens.b1
        ]
      );
      // A second, non-current bearer session for user A (sessionA itself is the current one,
      // seeded by resetFoundationDatabase).
      await client.query("DELETE FROM app.auth_sessions WHERE id = $1", [bearerA2]);
      await client.query(
        "INSERT INTO app.auth_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [bearerA2, ids.userA]
      );

      // Linked Macs: one live for A, one whose inactivity window has closed, one for B.
      await client.query("DELETE FROM app.companion_devices");
      await client.query(
        `INSERT INTO app.companion_devices
           (id, user_id, credential_hash, display_name, platform, app_version, os_version,
            created_at, last_contact_at, expires_at, absolute_expires_at)
         VALUES
           ($1, $2, 'hash-a1', 'Studio Mac', 'macos', '1.0.0', '14.5',
            now() - interval '3 days', now() - interval '10 minutes',
            now() + interval '90 days', now() + interval '365 days'),
           ($3, $2, 'hash-a2', 'Old Mac', 'macos', '1.0.0', '14.5',
            now() - interval '200 days', now() - interval '120 days',
            now() - interval '30 days', now() + interval '165 days'),
           ($4, $5, 'hash-b1', 'Other Mac', 'macos', '1.0.0', '14.5',
            now(), now(), now() + interval '90 days', now() + interval '365 days')`,
        [macA1, ids.userA, macAExpired, macB1, ids.userB]
      );
    });
  }

  async function companionDeviceExists(id: string): Promise<boolean> {
    return withBootstrap(async (client) => {
      const result = await client.query("SELECT 1 FROM app.companion_devices WHERE id = $1", [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async function cookieSessionExists(id: string): Promise<boolean> {
    return withBootstrap(async (client) => {
      const result = await client.query("SELECT 1 FROM app.better_auth_sessions WHERE id = $1", [
        id
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async function bearerSessionExists(id: string): Promise<boolean> {
    return withBootstrap(async (client) => {
      const result = await client.query("SELECT 1 FROM app.auth_sessions WHERE id = $1", [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  beforeEach(seedSessions);

  afterAll(async () => {
    await server?.close();
    await appDb?.destroy();
    await boss?.stop({ graceful: false });
  });

  it("lists own non-expired sessions, marks current, and never leaks a bearer secret or token", async () => {
    const res = await asUserA("GET", "/api/me/sessions");
    expect(res.statusCode).toBe(200);
    const body = res.json<ListMySessionsResponse>();
    const returnedIds = body.sessions.map((s) => s.id);

    // Bearer rows are exposed as handles; cookie rows by their non-secret id. Own, non-expired
    // only: current bearer + extra bearer + two cookie sessions. NOT the expired cookie, NOT B.
    expect(new Set(returnedIds)).toEqual(
      new Set([handleSessionA, handleBearerA2, cookieA1, cookieA2, macA1])
    );

    // HARD INVARIANT (the #315 blocker): the raw bearer secret (auth_sessions.id) must NEVER
    // appear in the response — not user A's own, and not any other user's.
    expect(res.payload).not.toContain(ids.sessionA);
    expect(res.payload).not.toContain(bearerA2);
    expect(res.payload).not.toContain(ids.sessionB);
    expect(res.payload).not.toContain(handleSessionB);

    const current = body.sessions.find((s) => s.id === handleSessionA);
    expect(current?.isCurrent).toBe(true);
    expect(current?.deviceLabel).toBe("CLI / API session");
    expect(body.sessions.filter((s) => s.isCurrent)).toHaveLength(1);

    const otherBearer = body.sessions.find((s) => s.id === handleBearerA2);
    expect(otherBearer?.isCurrent).toBe(false);
    expect(otherBearer?.deviceLabel).toBe("CLI / API session");

    const cookie = body.sessions.find((s) => s.id === cookieA1);
    expect(cookie?.isCurrent).toBe(false);
    expect(cookie?.deviceKind).toBe("laptop");
    expect(cookie?.browser).toBe("Chrome");
    expect(cookie?.os).toBe("macOS");
    expect(cookie?.ipAddress).toBe("203.0.113.7");

    // Cookie token secrets must never reach the response either.
    for (const token of Object.values(tokens)) {
      expect(res.payload).not.toContain(token);
    }
    expect(res.payload).not.toContain("token");
  });

  it("revokes one non-current cookie session by its id", async () => {
    const del = await asUserA("DELETE", `/api/me/sessions/${cookieA2}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });

    expect(await cookieSessionExists(cookieA2)).toBe(false);
    const list = (await asUserA("GET", "/api/me/sessions")).json<ListMySessionsResponse>();
    expect(list.sessions.map((s) => s.id)).not.toContain(cookieA2);
  });

  it("revokes a non-current bearer session via its public handle", async () => {
    const del = await asUserA("DELETE", `/api/me/sessions/${handleBearerA2}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });

    expect(await bearerSessionExists(bearerA2)).toBe(false);
    // The current bearer session is untouched.
    expect(await bearerSessionExists(ids.sessionA)).toBe(true);
    const list = (await asUserA("GET", "/api/me/sessions")).json<ListMySessionsResponse>();
    expect(list.sessions.map((s) => s.id)).not.toContain(handleBearerA2);
  });

  it("refuses to revoke the current session via its handle (422)", async () => {
    const del = await asUserA("DELETE", `/api/me/sessions/${handleSessionA}`);
    expect(del.statusCode).toBe(422);
    expect(await bearerSessionExists(ids.sessionA)).toBe(true);
    expect((await asUserA("GET", "/api/me/sessions")).statusCode).toBe(200);
  });

  it("does not let a raw bearer secret be used to revoke (404, session preserved)", async () => {
    // Passing the raw auth_sessions.id (the secret) is treated as a cookie id, matches no cookie
    // row, and must NOT delete the bearer session by raw id.
    const del = await asUserA("DELETE", `/api/me/sessions/${bearerA2}`);
    expect(del.statusCode).toBe(404);
    expect(await bearerSessionExists(bearerA2)).toBe(true);
  });

  it("does not reveal or revoke another user's session (404, rows preserved)", async () => {
    const cookieCross = await asUserA("DELETE", `/api/me/sessions/${cookieB1}`);
    expect(cookieCross.statusCode).toBe(404);
    expect(await cookieSessionExists(cookieB1)).toBe(true);

    const bearerCross = await asUserA("DELETE", `/api/me/sessions/${handleSessionB}`);
    expect(bearerCross.statusCode).toBe(404);
    expect(await bearerSessionExists(ids.sessionB)).toBe(true);
  });

  it("returns 404 for an unknown or malformed session id without a DB error", async () => {
    const unknownCookie = await asUserA(
      "DELETE",
      "/api/me/sessions/50000000-0000-4000-8000-0000deadbeef"
    );
    expect(unknownCookie.statusCode).toBe(404);
    const unknownHandle = await asUserA("DELETE", `/api/me/sessions/${handle("nope")}`);
    expect(unknownHandle.statusCode).toBe(404);
    const malformed = await asUserA("DELETE", "/api/me/sessions/not-a-uuid");
    expect(malformed.statusCode).toBe(404);
  });

  it("revokes all other sessions while preserving the current session", async () => {
    const del = await asUserA("DELETE", "/api/me/sessions/others");
    expect(del.statusCode).toBe(200);
    const payload = del.json<{ success: boolean; count: number }>();
    expect(payload.success).toBe(true);
    // User A's other sessions: the extra bearer, both cookie sessions, and the linked Mac.
    expect(payload.count).toBe(4);

    const list = (await asUserA("GET", "/api/me/sessions")).json<ListMySessionsResponse>();
    expect(list.sessions.map((s) => s.id)).toEqual([handleSessionA]);
    expect(list.sessions[0]?.isCurrent).toBe(true);

    // Other users' sessions are never touched by user A's bulk revoke.
    expect(await cookieSessionExists(cookieB1)).toBe(true);
    expect(await bearerSessionExists(ids.sessionB)).toBe(true);
    expect(await companionDeviceExists(macB1)).toBe(true);
  });

  // #2560 — a linked Mac is listed and signed out through the same screen as a browser.
  it("lists a linked Mac as a companion session and never shows its credential hash", async () => {
    const body = (await asUserA("GET", "/api/me/sessions")).json<ListMySessionsResponse>();
    const mac = body.sessions.find((s) => s.id === macA1);

    expect(mac?.source).toBe("companion");
    expect(mac?.deviceLabel).toBe("Studio Mac");
    expect(mac?.deviceKind).toBe("laptop");
    expect(mac?.os).toBe("macOS");
    expect(mac?.isCurrent).toBe(false);
    expect(mac?.companion).toMatchObject({
      product: "Trail Marker for Mac",
      displayName: "Studio Mac",
      appVersion: "1.0.0",
      osVersion: "14.5"
    });
    expect(mac?.companion?.lastContactAt).toBeTruthy();

    // A browser row carries no companion block at all.
    expect(body.sessions.find((s) => s.id === cookieA1)?.companion).toBeNull();
  });

  it("leaves an expired Mac and another user's Mac out of the list", async () => {
    const body = (await asUserA("GET", "/api/me/sessions")).json<ListMySessionsResponse>();
    const listed = body.sessions.map((s) => s.id);
    expect(listed).not.toContain(macAExpired);
    expect(listed).not.toContain(macB1);
  });

  it("signs out one linked Mac by its row id", async () => {
    const del = await asUserA("DELETE", `/api/me/sessions/${macA1}`);
    expect(del.statusCode).toBe(200);
    expect(await companionDeviceExists(macA1)).toBe(false);

    const list = (await asUserA("GET", "/api/me/sessions")).json<ListMySessionsResponse>();
    expect(list.sessions.map((s) => s.id)).not.toContain(macA1);
  });

  it("does not let one user sign out another user's Mac", async () => {
    const del = await asUserA("DELETE", `/api/me/sessions/${macB1}`);
    expect(del.statusCode).toBe(404);
    expect(await companionDeviceExists(macB1)).toBe(true);
  });
});

// Real Better Auth cookie-auth path (#315 QA gap). Signs up a user to mint a genuine cookie
// session, then proves current-session marking, current-session revoke refusal, and
// revoke-others preservation for the COOKIE path (the bearer path is covered above).
describe("#237 current-user active sessions — cookie auth", () => {
  const otherCookieId = "51000000-0000-4000-8000-0000000000c1";
  const otherCookieToken = "cookie-other-SECRET-must-not-leak";

  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let cookie: string;
  let ownerUserId: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    await setInstanceSetting("registration.requires_approval", { value: false });
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    // First sign-up bootstraps an active owner and returns a real Better Auth session cookie.
    const signUp = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name: "Owner", email: "owner@example.test", password: "correct horse battery" }
    });
    expect(signUp.statusCode).toBe(200);
    cookie = cookieHeader(signUp.headers);
    expect(cookie).toContain("better-auth");
    ownerUserId = signUp.json<{ user: { id: string } }>().user.id;

    // Inject a SECOND cookie session for the same user, so revoke-others has something to remove.
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.better_auth_sessions (id, user_id, token, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, now() + interval '1 day', now(), now())`,
        [otherCookieId, ownerUserId, otherCookieToken]
      );
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await server?.close();
    await appDb?.destroy();
    await boss?.stop({ graceful: false });
  });

  async function cookieSessionExists(id: string): Promise<boolean> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query("SELECT 1 FROM app.better_auth_sessions WHERE id = $1", [
        id
      ]);
      return (result.rowCount ?? 0) > 0;
    } finally {
      await client.end();
    }
  }

  it("marks the current cookie session, refuses its revoke (422), and preserves it on revoke-others", async () => {
    const list = await server.inject({
      method: "GET",
      url: "/api/me/sessions",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    const sessions = list.json<ListMySessionsResponse>().sessions;

    // Exactly one current session; it is the real signed-in cookie session (a UUID row id, not a
    // hashed bearer handle), and the injected second session is present but not current.
    const current = sessions.find((s) => s.isCurrent);
    expect(current).toBeDefined();
    expect(sessions.filter((s) => s.isCurrent)).toHaveLength(1);
    const currentCookieId = current!.id;
    expect(currentCookieId).not.toBe(otherCookieId);
    expect(sessions.map((s) => s.id)).toEqual(
      expect.arrayContaining([currentCookieId, otherCookieId])
    );

    // Refuse revoking the current cookie session through this surface.
    const refuse = await server.inject({
      method: "DELETE",
      url: `/api/me/sessions/${currentCookieId}`,
      headers: { cookie }
    });
    expect(refuse.statusCode).toBe(422);
    expect(await cookieSessionExists(currentCookieId)).toBe(true);

    // Revoke-others removes the injected session but preserves the current one.
    const others = await server.inject({
      method: "DELETE",
      url: "/api/me/sessions/others",
      headers: { cookie }
    });
    expect(others.statusCode).toBe(200);
    expect(others.json<{ count: number }>().count).toBe(1);
    expect(await cookieSessionExists(otherCookieId)).toBe(false);
    expect(await cookieSessionExists(currentCookieId)).toBe(true);

    // The current cookie session still authenticates and is still the sole, current entry.
    const after = await server.inject({
      method: "GET",
      url: "/api/me/sessions",
      headers: { cookie }
    });
    expect(after.statusCode).toBe(200);
    const afterSessions = after.json<ListMySessionsResponse>().sessions;
    expect(afterSessions.map((s) => s.id)).toEqual([currentCookieId]);
    expect(afterSessions[0]?.isCurrent).toBe(true);
  });
});

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];

  return cookies.map((entry) => entry.split(";", 1)[0]).join("; ");
}

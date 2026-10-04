import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Base64url } from "@moss/auth";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { SettingsRepository } from "../../packages/settings/src/repository.js";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2638 plan §4.7).
//
// Backtrack's session-authenticated routes over the real API server: status, the pause switch and
// delete, plus the end-to-end check that a delete through the route is honoured by a later ingest
// retry (both sides use the same overlap predicate).

const { Client } = pg;
const VERIFIER = "v".repeat(43);
const TRUSTED_ORIGIN = "http://localhost:3000";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let server: ReturnType<typeof createApiServer>;
let boss: PgBoss;
let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let bootstrap: pg.Client;
let originalStorage: string | undefined;
let credentialA: string;
let sendSpy: ReturnType<typeof vi.spyOn>;

let addressCounter = 0;
function nextAddress(): string {
  addressCounter += 1;
  return `10.30.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

const session = (userId: string) => ({
  authorization: `Bearer ${userId === ids.userA ? ids.sessionA : ids.sessionB}`
});

async function linkMac(sessionToken: string, deviceName: string): Promise<string> {
  const pair = await server.inject({
    method: "POST",
    url: "/api/companion/pair",
    payload: {
      deviceName,
      platform: "macos",
      appVersion: "1.0.0",
      osVersion: "14.5",
      verifierHash: sha256Base64url(VERIFIER)
    }
  });
  const body = pair.json() as { attemptId: string; approvalPath: string };
  const code = new URLSearchParams(
    new URL(body.approvalPath, "http://x").hash.replace(/^#/, "")
  ).get("code");
  const decided = await server.inject({
    method: "POST",
    url: "/api/companion/pair/decide",
    headers: { authorization: `Bearer ${sessionToken}`, origin: TRUSTED_ORIGIN },
    payload: { code, decision: "approve" }
  });
  expect(decided.statusCode).toBe(200);
  const redeemed = await server.inject({
    method: "POST",
    url: "/api/companion/pair/redeem",
    payload: { attemptId: body.attemptId, verifier: VERIFIER }
  });
  return (redeemed.json() as { credential: string }).credential;
}

/** One segment per spec, `start` an offset in ms from the pinned `base` (negative = past). */
function uploadBody(
  specs: readonly { start: number; length?: number; body?: string }[],
  base = Date.now()
) {
  return {
    sentAt: new Date().toISOString(),
    segments: specs.map((spec, i) => ({
      startedAt: new Date(base + spec.start).toISOString(),
      endedAt: new Date(base + spec.start + (spec.length ?? 20_000)).toISOString(),
      appName: "Safari",
      bundleId: "com.apple.Safari",
      windowTitle: "A page",
      body: spec.body ?? `segment ${i} ${spec.start}`
    }))
  };
}

function upload(payload: unknown) {
  return server.inject({
    method: "POST",
    url: "/api/companion/backtrack",
    headers: { authorization: `Bearer ${credentialA}` },
    remoteAddress: nextAddress(),
    payload: payload as never
  });
}

interface SeedOptions {
  readonly owner?: string;
  readonly deviceId?: string;
  readonly startedAgo: number;
  readonly length?: number;
  readonly body?: string;
}

async function seed(options: SeedOptions): Promise<string> {
  const id = randomUUID();
  await bootstrap.query(
    `INSERT INTO app.backtrack_segments
       (id, owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title,
        body, body_hash, client_started_at)
     VALUES ($1, $2, $3, now() - ($4 || ' milliseconds')::interval,
        now() - ($4 || ' milliseconds')::interval + ($5 || ' milliseconds')::interval,
        'Safari', 'com.apple.Safari', 'A page', $6, $7, now())`,
    [
      id,
      options.owner ?? ids.userA,
      options.deviceId ?? randomUUID(),
      String(options.startedAgo),
      String(options.length ?? 10_000),
      options.body ?? `body ${id}`,
      randomBytes(32)
    ]
  );
  await bootstrap.query(
    `INSERT INTO app.memory_chunks
       (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
     VALUES ($1, 'screen', $2, 0, 0, 'h', 'chunk')`,
    [options.owner ?? ids.userA, `backtrack/${id}`]
  );
  return id;
}

async function segmentIds(owner: string): Promise<string[]> {
  const result = await bootstrap.query<{ id: string }>(
    "SELECT id FROM app.backtrack_segments WHERE owner_user_id = $1 ORDER BY started_at",
    [owner]
  );
  return result.rows.map((row) => row.id);
}

async function chunkPaths(owner: string): Promise<string[]> {
  const result = await bootstrap.query<{ source_path: string }>(
    "SELECT source_path FROM app.memory_chunks WHERE owner_user_id = $1 AND source_kind = 'screen' ORDER BY source_path",
    [owner]
  );
  return result.rows.map((row) => row.source_path);
}

const del = (userId: string, payload?: unknown) =>
  server.inject({
    method: "DELETE",
    url: "/api/backtrack/segments",
    headers: session(userId),
    ...(payload === undefined ? {} : { payload: payload as never })
  });

beforeAll(async () => {
  originalStorage = process.env.MOSS_BACKTRACK_STORAGE;
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = createApiServer({ appDb, boss, logger: { level: "silent" } });
  await server.ready();
  credentialA = await linkMac(ids.sessionA, "Backtrack routes Mac");
});

beforeEach(async () => {
  process.env.MOSS_BACKTRACK_STORAGE = "on";
  await bootstrap.query("DELETE FROM app.backtrack_segments");
  await bootstrap.query("DELETE FROM app.backtrack_deletions");
  await bootstrap.query("DELETE FROM app.backtrack_preferences");
  await bootstrap.query("DELETE FROM app.memory_chunks");
  sendSpy = vi.spyOn(boss, "send").mockImplementation((async () => randomUUID()) as never);
});

afterEach(() => {
  sendSpy.mockRestore();
});

afterAll(async () => {
  await Promise.allSettled([
    server?.close(),
    appDb?.destroy(),
    boss?.stop({ graceful: false }),
    bootstrap?.end()
  ]);
  if (originalStorage === undefined) delete process.env.MOSS_BACKTRACK_STORAGE;
  else process.env.MOSS_BACKTRACK_STORAGE = originalStorage;
});

describe("GET /api/backtrack/status", () => {
  it("needs a session", async () => {
    const res = await server.inject({ method: "GET", url: "/api/backtrack/status" });
    expect(res.statusCode).toBe(401);
  });

  it("counts only the actor's rows", async () => {
    const macOne = randomUUID();
    const macTwo = randomUUID();
    await seed({ deviceId: macOne, startedAgo: 2 * HOUR, body: "abcde" });
    await seed({ deviceId: macOne, startedAgo: HOUR, body: "fgh" });
    await seed({ deviceId: macTwo, startedAgo: 3 * DAY });
    await seed({ deviceId: randomUUID(), startedAgo: 40 * DAY }); // old Mac: outside the 30 days
    for (let i = 0; i < 5; i += 1) await seed({ owner: ids.userB, startedAgo: i * HOUR });

    const res = await server.inject({
      method: "GET",
      url: "/api/backtrack/status",
      headers: session(ids.userA)
    });
    expect(res.statusCode).toBe(200);
    const status = res.json() as Record<string, unknown>;
    expect(status).toMatchObject({ storage: "on", paused: false, macs: 2 });
    // Three calendar days of rows, four if the two recent ones straddle midnight.
    expect([3, 4]).toContain(status.days);
    expect(status.bytes).toBeGreaterThan(0);
    expect(typeof status.oldest).toBe("string");
    expect(typeof status.lastReceivedAt).toBe("string");
    expect(new Date(status.oldest as string).getTime()).toBeLessThan(Date.now() - 39 * DAY);

    // Person B's five rows are not in A's numbers, and an empty owner reports zeros.
    const empty = await server.inject({
      method: "GET",
      url: "/api/backtrack/status",
      headers: session(ids.userB)
    });
    expect(empty.json()).toMatchObject({ macs: 5 });
    await bootstrap.query("DELETE FROM app.backtrack_segments WHERE owner_user_id = $1", [
      ids.userB
    ]);
    const none = await server.inject({
      method: "GET",
      url: "/api/backtrack/status",
      headers: session(ids.userB)
    });
    expect(none.json()).toEqual({ storage: "on", paused: false, macs: 0, days: 0, bytes: 0 });
  });
});

describe("with storage off the person can still see their state and delete", () => {
  it("answers status, pause and delete, even with the module disabled for them", async () => {
    const id = await seed({ startedAgo: 5 * MINUTE });
    process.env.MOSS_BACKTRACK_STORAGE = "off";
    const settings = new SettingsRepository();
    const toggle = (disabled: boolean) =>
      Promise.all([
        dataContext.withDataContext({ actorUserId: ids.adminUser, requestId: "t:bt-off" }, (db) =>
          settings.setInstanceModuleDisabled(db, {
            moduleId: "backtrack",
            disabled,
            actorUserId: ids.adminUser,
            requestId: "t:bt-off"
          })
        ),
        dataContext.withDataContext({ actorUserId: ids.userA, requestId: "t:bt-off" }, (db) =>
          settings.setUserModuleDisabled(db, {
            moduleId: "backtrack",
            disabled,
            actorUserId: ids.userA,
            requestId: "t:bt-off"
          })
        )
      ]);
    await toggle(true);
    try {
      const status = await server.inject({
        method: "GET",
        url: "/api/backtrack/status",
        headers: session(ids.userA)
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ storage: "off", macs: 1 });

      const pause = await server.inject({
        method: "PUT",
        url: "/api/backtrack/preferences",
        headers: session(ids.userA),
        payload: { paused: true }
      });
      expect(pause.statusCode).toBe(200);

      const deleted = await del(ids.userA);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ deleted: 1 });
      expect(await segmentIds(ids.userA)).not.toContain(id);
      expect(await chunkPaths(ids.userA)).toEqual([]);
    } finally {
      await toggle(false);
    }
  });
});

describe("PUT /api/backtrack/preferences", () => {
  it("pauses ingest within one request, resumes it, and is per person", async () => {
    const put = (paused: unknown, user = ids.userA) =>
      server.inject({
        method: "PUT",
        url: "/api/backtrack/preferences",
        headers: session(user),
        payload: { paused } as never
      });

    expect((await upload(uploadBody([{ start: -5 * MINUTE }]))).statusCode).toBe(200);

    expect((await put(true)).json()).toEqual({ paused: true });
    const refused = await upload(uploadBody([{ start: -4 * MINUTE }]));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "backtrack_paused" });
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/backtrack/status",
          headers: session(ids.userA)
        })
      ).json()
    ).toMatchObject({ paused: true });
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/backtrack/status",
          headers: session(ids.userB)
        })
      ).json()
    ).toMatchObject({ paused: false });

    expect((await put(false)).json()).toEqual({ paused: false });
    expect((await upload(uploadBody([{ start: -3 * MINUTE }]))).statusCode).toBe(200);

    expect((await put("yes")).statusCode).toBe(400);
  });
});

describe("DELETE /api/backtrack/segments", () => {
  it("removes rows and chunks inside the range for the actor only, and writes its marker", async () => {
    await seed({ startedAgo: 3 * HOUR });
    await seed({ startedAgo: 4 * HOUR + 5_000, length: 20_000 }); // crosses `from`
    const before = await seed({ startedAgo: 6 * HOUR });
    const after = await seed({ startedAgo: 30 * MINUTE });
    const others = await seed({ owner: ids.userB, startedAgo: 3 * HOUR });

    const from = new Date(Date.now() - 4 * HOUR);
    const to = new Date(Date.now() - HOUR);
    const res = await del(ids.userA, { from: from.toISOString(), to: to.toISOString() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    expect(await segmentIds(ids.userA)).toEqual([before, after]);
    expect(await chunkPaths(ids.userA)).toEqual(
      [`backtrack/${after}`, `backtrack/${before}`].sort()
    );
    expect(await segmentIds(ids.userB)).toEqual([others]);
    expect(await chunkPaths(ids.userB)).toEqual([`backtrack/${others}`]);

    const markers = await bootstrap.query<{ owner: string; lo: Date; hi: Date }>(
      "SELECT owner_user_id::text AS owner, lower(range) AS lo, upper(range) AS hi FROM app.backtrack_deletions"
    );
    expect(markers.rows).toHaveLength(1);
    expect(markers.rows[0]?.owner).toBe(ids.userA);
    expect(markers.rows[0]?.lo.getTime()).toBe(from.getTime());
    expect(markers.rows[0]?.hi.getTime()).toBe(to.getTime());
  });

  it("cuts a marker that reaches into the future at the moment of deletion", async () => {
    await seed({ startedAgo: 10 * MINUTE });
    const before = Date.now();
    const res = await del(ids.userA, {
      from: new Date(before - 2 * HOUR).toISOString(),
      to: new Date(before + 5 * HOUR).toISOString()
    });
    expect(res.json()).toEqual({ deleted: 1 });
    const marker = await bootstrap.query<{ hi: Date }>(
      "SELECT upper(range) AS hi FROM app.backtrack_deletions"
    );
    const upper = marker.rows[0]?.hi.getTime() ?? Infinity;
    expect(upper).toBeGreaterThanOrEqual(before);
    expect(upper).toBeLessThanOrEqual(Date.now());
  });

  it("deletes everything, and its marker is open at the start, for no body and for {}", async () => {
    for (const payload of [undefined, {}]) {
      await bootstrap.query("DELETE FROM app.backtrack_deletions");
      await seed({ startedAgo: 40 * DAY });
      await seed({ startedAgo: 2 * HOUR });
      const res = await del(ids.userA, payload);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: 2 });
      expect(await segmentIds(ids.userA)).toEqual([]);
      expect(await chunkPaths(ids.userA)).toEqual([]);
      const marker = await bootstrap.query<{ lo: Date | null; unbounded: boolean }>(
        "SELECT lower(range) AS lo, lower_inf(range) AS unbounded FROM app.backtrack_deletions"
      );
      expect(marker.rows).toEqual([{ lo: null, unbounded: true }]);
    }
  });

  it("deletes nothing and writes no marker for a day that hasn't begun", async () => {
    await seed({ startedAgo: HOUR });
    const now = Date.now();
    const res = await del(ids.userA, {
      from: new Date(now + DAY).toISOString(),
      to: new Date(now + 2 * DAY).toISOString()
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 0 });
    expect(await segmentIds(ids.userA)).toHaveLength(1);
    expect(await bootstrap.query("SELECT 1 FROM app.backtrack_deletions")).toMatchObject({
      rowCount: 0
    });
  });

  it("everything: an upload holding the lock when the delete arrives is deleted and covered by the marker", async () => {
    // Stand in for an ingest mid-transaction: hold the owner lock, let the delete queue behind
    // it, then commit a segment captured after the delete was sent.
    await bootstrap.query("BEGIN");
    let pending: ReturnType<typeof del> | undefined;
    let capturedAt: Date;
    try {
      await bootstrap.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('backtrack:' || $1::text, 0))",
        [ids.userA]
      );
      pending = del(ids.userA);
      await new Promise((resolve) => setTimeout(resolve, 100));
      capturedAt = new Date();
      await bootstrap.query(
        `INSERT INTO app.backtrack_segments
           (owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title,
            body, body_hash, client_started_at)
         VALUES ($1, $2, $3, $3, 'Safari', 'com.apple.Safari', 'A page', 'late', $4, $3)`,
        [ids.userA, randomUUID(), capturedAt, randomBytes(32)]
      );
      await bootstrap.query("COMMIT");
    } catch (error) {
      await bootstrap.query("ROLLBACK");
      throw error;
    }

    expect((await pending).json()).toEqual({ deleted: 1 });
    expect(await segmentIds(ids.userA)).toEqual([]);
    const covered = await bootstrap.query<{ covered: boolean }>(
      "SELECT range @> $1::timestamptz AS covered FROM app.backtrack_deletions",
      [capturedAt]
    );
    expect(covered.rows).toEqual([{ covered: true }]);
  });

  it("rejects a half range, a backwards or oversized one, junk, and deletes nothing", async () => {
    await seed({ startedAgo: HOUR });
    const now = Date.now();
    const iso = (offset: number) => new Date(now + offset).toISOString();
    const bad: unknown[] = [
      { from: iso(-HOUR) },
      { to: iso(-HOUR) },
      { from: iso(-HOUR), to: iso(-HOUR) },
      { from: iso(-MINUTE), to: iso(-HOUR) },
      { from: iso(-32 * DAY), to: iso(0) },
      { from: "yesterday-ish", to: iso(0) },
      { from: iso(-HOUR), to: iso(0), owner: ids.userB },
      []
    ];
    for (const payload of bad) {
      const res = await del(ids.userA, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await segmentIds(ids.userA)).toHaveLength(1);
    expect(await bootstrap.query("SELECT 1 FROM app.backtrack_deletions")).toMatchObject({
      rowCount: 0
    });

    // Exactly 31 days apart is the longest allowed range.
    const edge = await del(ids.userA, { from: iso(-31 * DAY - MINUTE), to: iso(-MINUTE) });
    expect(edge.statusCode).toBe(200);
  });

  it("needs a session", async () => {
    const res = await server.inject({ method: "DELETE", url: "/api/backtrack/segments" });
    expect(res.statusCode).toBe(401);
  });
});

describe("a delete through the route is honoured by a later ingest retry", () => {
  it("everything: the same batch sent again is discarded, a later capture is accepted", async () => {
    const base = Date.now();
    const batch = (sentAt: Date) => ({
      ...uploadBody([{ start: -20 * MINUTE }, { start: -10 * MINUTE }], base),
      sentAt: sentAt.toISOString()
    });
    const first = await upload(batch(new Date()));
    expect(first.json()).toMatchObject({ accepted: 2 });
    expect(await del(ids.userA)).toMatchObject({ statusCode: 200 });
    expect(await segmentIds(ids.userA)).toHaveLength(0);

    const retry = await upload(batch(new Date()));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ accepted: 0, discarded: 2 });
    expect(await segmentIds(ids.userA)).toHaveLength(0);
    expect(await chunkPaths(ids.userA)).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const fresh = await upload(uploadBody([{ start: -10, length: 0, body: "after the delete" }]));
    expect(fresh.json()).toMatchObject({ accepted: 1, discarded: 0 });
  });

  it("a range: a pre-delete segment arriving late is discarded, one outside the range is kept", async () => {
    const base = Date.now();
    await upload(uploadBody([{ start: -3 * HOUR }], base));
    const res = await del(ids.userA, {
      from: new Date(base - 4 * HOUR).toISOString(),
      to: new Date(base - 2 * HOUR).toISOString()
    });
    expect(res.json()).toEqual({ deleted: 1 });

    const late = await upload(
      uploadBody([{ start: -3 * HOUR + 60_000 }, { start: -MINUTE }], base)
    );
    expect(late.json()).toMatchObject({ accepted: 1, discarded: 1 });
  });
});

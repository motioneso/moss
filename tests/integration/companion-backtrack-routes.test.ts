import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { sha256Base64url } from "@moss/auth";
import { BacktrackRepository } from "@moss/backtrack";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file.
//
// Backtrack phase 2a ingest (#2638, plan 2026-10-03-backtrack-phase2.md §4.4) over the real API
// server. Time is controlled by what each request says (`sentAt`, segment stamps) relative to the
// moment the request is built and by the instants the deletion markers are written at, never by
// sleeping: the route reads its own clock once per request, so a scenario is laid out in the
// seconds and minutes before "now".

const { Client } = pg;
const VERIFIER = "v".repeat(43);
const TRUSTED_ORIGIN = "http://localhost:3000";
const MARKER = "backtrack-route-marker-5e7a2c";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let server: ReturnType<typeof createApiServer>;
let boss: PgBoss;
let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let bootstrap: pg.Client;
let originalStorage: string | undefined;
const logLines: string[] = [];
const repo = new BacktrackRepository();

let credentialA: string;
let credentialA2: string;
let credentialB: string;

// Each request comes from its own address so the route's per-IP limit (10 a minute) never
// throttles a scenario; the limit itself is not what these tests are about.
let addressCounter = 0;
function nextAddress(): string {
  addressCounter += 1;
  return `10.20.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

function logStream(): Writable {
  return new Writable({
    write(chunk, _encoding, done) {
      logLines.push(String(chunk));
      done();
    }
  });
}

async function startAttempt(deviceName: string) {
  const res = await server.inject({
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
  expect(res.statusCode).toBe(200);
  const body = res.json() as { attemptId: string; approvalPath: string };
  const hash = new URL(body.approvalPath, "http://x").hash.replace(/^#/, "");
  const code = new URLSearchParams(hash).get("code");
  if (!code) throw new Error("approval path carried no code");
  return { attemptId: body.attemptId, code };
}

async function linkMac(session: string, deviceName: string): Promise<string> {
  const { attemptId, code } = await startAttempt(deviceName);
  const decided = await server.inject({
    method: "POST",
    url: "/api/companion/pair/decide",
    headers: { authorization: `Bearer ${session}`, origin: TRUSTED_ORIGIN },
    payload: { code, decision: "approve" }
  });
  expect(decided.statusCode).toBe(200);
  const redeemed = await server.inject({
    method: "POST",
    url: "/api/companion/pair/redeem",
    payload: { attemptId, verifier: VERIFIER }
  });
  expect(redeemed.statusCode).toBe(200);
  return (redeemed.json() as { credential: string }).credential;
}

function upload(credential: string, payload: unknown) {
  return server.inject({
    method: "POST",
    url: "/api/companion/backtrack",
    headers: { authorization: `Bearer ${credential}` },
    remoteAddress: nextAddress(),
    payload: payload as never
  });
}

interface SegSpec {
  /** Server-time start, as an offset from now (negative = in the past). */
  readonly start: number;
  readonly length?: number;
  readonly body?: string;
  readonly appName?: string;
  readonly windowTitle?: string;
  readonly address?: string;
}

/**
 * A request as a Mac whose clock runs `clockOffset` ms ahead of the server (negative: behind)
 * would build it. `base` pins "now" so a retry can reuse the exact same raw client stamps.
 */
function request(
  specs: readonly SegSpec[],
  options: { clockOffset?: number; base?: number; sentAtOffset?: number } = {}
) {
  const clockOffset = options.clockOffset ?? 0;
  const base = options.base ?? Date.now();
  return {
    sentAt: new Date(Date.now() + clockOffset + (options.sentAtOffset ?? 0)).toISOString(),
    segments: specs.map((spec, i) => ({
      startedAt: new Date(base + spec.start + clockOffset).toISOString(),
      endedAt: new Date(base + spec.start + (spec.length ?? 20_000) + clockOffset).toISOString(),
      appName: spec.appName ?? "Safari",
      bundleId: "com.apple.Safari",
      windowTitle: spec.windowTitle ?? "A page",
      ...(spec.address === undefined ? {} : { address: spec.address }),
      body: spec.body ?? `body of segment ${i} at ${spec.start} ${randomUUID()}`
    }))
  };
}

async function stored(userId?: string) {
  const result = await bootstrap.query<{
    id: string;
    owner_user_id: string;
    device_id: string;
    started_at: Date;
    window_title: string;
    address: string | null;
    body: string;
  }>(
    `SELECT id, owner_user_id, device_id, started_at, window_title, address, body
       FROM app.backtrack_segments
      ${userId ? "WHERE owner_user_id = $1" : ""} ORDER BY started_at`,
    userId ? [userId] : []
  );
  return result.rows;
}

async function deleteRange(
  userId: string,
  from: Date | null,
  to: Date | null,
  deletedAt: Date = new Date()
) {
  await dataContext.withDataContext({ actorUserId: userId, requestId: "bt-delete" }, async (db) => {
    await repo.lockOwner(db, userId);
    await repo.deleteSegmentsInRange(db, userId, { from, to });
    await repo.insertDeletionMarker(db, userId, from, to, deletedAt);
  });
}

async function chunkCount(): Promise<number> {
  const result = await bootstrap.query<{ count: string }>(
    "SELECT count(*) FROM app.memory_chunks WHERE owner_user_id = $1",
    [ids.userA]
  );
  return Number(result.rows[0]?.count ?? 0);
}

const sendCalls: { queue: string; payload: unknown }[] = [];
let sendSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  originalStorage = process.env.MOSS_BACKTRACK_STORAGE;
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();

  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = createApiServer({
    appDb,
    boss,
    logger: { level: "info", stream: logStream() }
  });
  await server.ready();

  credentialA = await linkMac(ids.sessionA, "Backtrack Mac A");
  credentialA2 = await linkMac(ids.sessionA, "Backtrack Mac A2");
  credentialB = await linkMac(ids.sessionB, "Backtrack Mac B");
});

beforeEach(async () => {
  process.env.MOSS_BACKTRACK_STORAGE = "on";
  await bootstrap.query("DELETE FROM app.backtrack_segments");
  await bootstrap.query("DELETE FROM app.backtrack_deletions");
  await bootstrap.query("DELETE FROM app.backtrack_preferences");
  sendCalls.length = 0;
  logLines.length = 0;
  sendSpy = vi.spyOn(boss, "send").mockImplementation((async (queue: string, payload: unknown) => {
    sendCalls.push({ queue, payload });
    return randomUUID();
  }) as never);
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

describe("who an upload belongs to", () => {
  it("is the credential's owner, whatever the body says", async () => {
    const payload = { ...request([{ start: -5 * MINUTE }]), ownerUserId: ids.userB };
    const res = await upload(credentialA, payload);
    // The schema has no owner field; Fastify strips unknown properties, so the upload is taken as
    // person A's own. Fails if the body could set the owner.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1 });
    expect((await stored(ids.userA)).length).toBe(1);
    expect((await stored(ids.userB)).length).toBe(0);

    const other = await upload(credentialB, request([{ start: -5 * MINUTE }]));
    expect(other.statusCode).toBe(200);
    expect((await stored(ids.userB)).length).toBe(1);
  });

  it("records the uploading Mac, and two Macs of one person share the owner", async () => {
    await upload(credentialA, request([{ start: -5 * MINUTE }]));
    await upload(credentialA2, request([{ start: -6 * MINUTE }]));
    const rows = await stored(ids.userA);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.device_id)).size).toBe(2);
  });

  it("refuses a browser session, a made-up token and no credential at all", async () => {
    for (const authorization of [`Bearer ${ids.sessionA}`, "Bearer jst_notarealtoken", undefined]) {
      const res = await server.inject({
        method: "POST",
        url: "/api/companion/backtrack",
        headers: authorization ? { authorization } : {},
        remoteAddress: nextAddress(),
        payload: request([{ start: -5 * MINUTE }])
      });
      expect(res.statusCode, String(authorization)).toBe(401);
    }
    expect(await stored()).toHaveLength(0);
  });
});

describe("the switch and the pause", () => {
  it("answers 409 backtrack_unavailable with the switch off, and stores nothing", async () => {
    process.env.MOSS_BACKTRACK_STORAGE = "off";
    const res = await upload(credentialA, request([{ start: -5 * MINUTE }]));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "backtrack_unavailable" });
    expect(await stored()).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });

  it("answers 409 backtrack_paused while the person has paused, and stores nothing", async () => {
    await dataContext.withDataContext({ actorUserId: ids.userA, requestId: "bt-pause" }, (db) =>
      repo.setPaused(db, ids.userA, true)
    );
    const res = await upload(credentialA, request([{ start: -5 * MINUTE }]));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "backtrack_paused" });
    expect(await stored()).toHaveLength(0);

    // The pause is the person's, not the instance's: another person still records.
    const other = await upload(credentialB, request([{ start: -5 * MINUTE }]));
    expect(other.statusCode).toBe(200);
  });

  it("reports the state on the heartbeat and on every upload", async () => {
    const beat = () =>
      server.inject({
        method: "POST",
        url: "/api/companion/heartbeat",
        headers: { authorization: `Bearer ${credentialA}` },
        remoteAddress: nextAddress(),
        payload: { appVersion: "1.0.0", osVersion: "14.5" }
      });
    expect((await beat()).json()).toMatchObject({ backtrack: { storage: "on", paused: false } });

    const res = await upload(credentialA, request([{ start: -5 * MINUTE }]));
    expect(res.json()).toMatchObject({ state: { storage: "on", paused: false } });

    await dataContext.withDataContext({ actorUserId: ids.userA, requestId: "bt-pause" }, (db) =>
      repo.setPaused(db, ids.userA, true)
    );
    expect((await beat()).json()).toMatchObject({ backtrack: { storage: "on", paused: true } });
    process.env.MOSS_BACKTRACK_STORAGE = "off";
    expect((await beat()).json()).toMatchObject({ backtrack: { storage: "off", paused: true } });
  });
});

describe("what is stored, and what is never kept", () => {
  it("stores title, address and body with secrets redacted", async () => {
    const res = await upload(
      credentialA,
      request([
        {
          start: -5 * MINUTE,
          windowTitle: "Keys sk-proj-abcdefghijklmnop1234 page",
          address: "https://example.test/cb?api_key=hunter2hunter2&page=2",
          body: "token ghp_abcdefghijklmnopqrst and ?token=hunter2hunter2 and Bearer abc.def.ghi"
        }
      ])
    );
    expect(res.statusCode).toBe(200);
    const [row] = await stored(ids.userA);
    const everything = `${row?.window_title}\n${row?.address}\n${row?.body}`;
    for (const secret of [
      "sk-proj-abcdefghijklmnop1234",
      "ghp_abcdefghijklmnopqrst",
      "hunter2hunter2",
      "abc.def.ghi"
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(row?.window_title).toContain("[redacted]");
    expect(row?.address).toContain("page=2");
    expect(row?.body).toContain("[redacted]");
    // The hash is of the redacted text, so it matches what is stored.
    const hash = await bootstrap.query<{ body_hash: Buffer }>(
      "SELECT body_hash FROM app.backtrack_segments WHERE id = $1",
      [row?.id]
    );
    expect(
      hash.rows[0]?.body_hash.equals(
        createHash("sha256")
          .update(row?.body ?? "")
          .digest()
      )
    ).toBe(true);
  });

  it("never puts captured text in a log line or a job payload, valid or not", async () => {
    const marked = request([
      {
        start: -5 * MINUTE,
        appName: `app ${MARKER}`,
        windowTitle: `title ${MARKER}`,
        address: `https://example.test/${MARKER}`,
        body: `body ${MARKER}`
      }
    ]);
    const ok = await upload(credentialA, marked);
    expect(ok.statusCode).toBe(200);

    // Schema-invalid: a missing field and an unknown field next to marked text.
    const invalid = await upload(credentialA, {
      sentAt: new Date().toISOString(),
      segments: [{ ...marked.segments[0], endedAt: undefined, extra: MARKER }]
    });
    expect(invalid.statusCode).toBe(400);
    const tooLong = await upload(credentialA, {
      ...marked,
      segments: [{ ...marked.segments[0], body: `${MARKER} ${"x".repeat(9000)}` }]
    });
    expect(tooLong.statusCode).toBe(400);
    // Neither refusal text nor log may echo what was sent.
    expect(invalid.body).not.toContain(MARKER);
    expect(tooLong.body).not.toContain(MARKER);

    expect(logLines.join("")).not.toContain(MARKER);
    expect(JSON.stringify(sendCalls)).not.toContain(MARKER);
    // The log did capture this server's traffic, so the assertion above is not vacuous.
    expect(logLines.join("")).toContain("/api/companion/backtrack");
  });

  it("enqueues ids only, after the commit, and nothing for a batch that stored nothing", async () => {
    const batch = request([{ start: -5 * MINUTE }, { start: -4 * MINUTE }]);
    const res = await upload(credentialA, batch);
    expect(res.statusCode).toBe(200);
    const rows = await stored(ids.userA);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.queue).toBe("backtrack.index");
    const payload = sendCalls[0]?.payload as { actorUserId: string; segmentIds: string[] };
    expect(Object.keys(payload).sort()).toEqual(["actorUserId", "segmentIds"]);
    expect(payload.actorUserId).toBe(ids.userA);
    expect([...payload.segmentIds].sort()).toEqual(rows.map((row) => row.id).sort());

    // The identical batch again is all duplicates: no new rows, so no job.
    sendCalls.length = 0;
    const dup = await upload(credentialA, { ...batch, sentAt: new Date().toISOString() });
    expect(dup.statusCode).toBe(200);
    expect(sendCalls).toHaveLength(0);
  });

  it("still answers success when the job cannot be enqueued", async () => {
    sendSpy.mockRejectedValue(new Error("queue is down"));
    const res = await upload(credentialA, request([{ start: -5 * MINUTE }]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1 });
    expect(await stored(ids.userA)).toHaveLength(1);
  });
});

describe("size limits", () => {
  it("refuses 201 segments and a 9 KB body", async () => {
    const tooMany = await upload(
      credentialA,
      request(Array.from({ length: 201 }, (_, i) => ({ start: -(i + 5) * MINUTE })))
    );
    expect(tooMany.statusCode).toBe(400);

    const bigBody = await upload(
      credentialA,
      request([{ start: -5 * MINUTE, body: "b".repeat(9 * 1024) }])
    );
    expect(bigBody.statusCode).toBe(400);
    expect(await stored()).toHaveLength(0);
  });

  it("drops a segment that is under the character limit but over the byte limit, keeping the rest", async () => {
    const res = await upload(
      credentialA,
      request([
        { start: -5 * MINUTE, body: "€".repeat(2800) }, // 2800 characters, 8400 bytes
        { start: -4 * MINUTE }
      ])
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1 });
    expect(await stored(ids.userA)).toHaveLength(1);
  });

  it("accepts 200 maximum-size segments in a body of nearly 2 MiB", async () => {
    const fill = (n: number, seed: string) =>
      `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
    const batch = request(
      Array.from({ length: 200 }, (_, i) => ({
        start: -(i + 3) * 30_000,
        length: 10_000,
        windowTitle: fill(1000, `title${i}`),
        address: `https://example.test/${fill(380, `p${i}`).replace(/ /g, "-")}`,
        body: fill(8192, `word${i}`)
      }))
    );
    const encoded = Buffer.byteLength(JSON.stringify(batch), "utf8");
    // Over Fastify's default 1 MiB, so this fails at the default limit; under the route's 2 MiB.
    expect(encoded).toBeGreaterThan(1024 * 1024);
    expect(encoded).toBeLessThan(2 * 1024 * 1024);
    expect(encoded).toBeGreaterThan(1.8 * 1024 * 1024);

    const res = await upload(credentialA, batch);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 200, duplicates: 0, discarded: 0 });
    expect(await stored(ids.userA)).toHaveLength(200);
    const payload = sendCalls[0]?.payload as { segmentIds: string[] };
    expect(payload.segmentIds).toHaveLength(200);
  });
});

describe("deletions are final (decision 10)", () => {
  it("discards a lost-response retry after 'Today' was deleted, and creates no chunk", async () => {
    const base = Date.now();
    const batch = request([{ start: -50 * MINUTE }, { start: -40 * MINUTE }], { base });
    expect((await upload(credentialA, batch)).json()).toMatchObject({ accepted: 2 });

    const chunksBefore = await chunkCount();
    await deleteRange(ids.userA, new Date(base - 10 * HOUR), new Date());
    expect(await stored(ids.userA)).toHaveLength(0);
    sendCalls.length = 0;

    // The response was lost; the Mac resends the same segments with a fresh sentAt.
    const retry = { ...batch, sentAt: new Date().toISOString() };
    const res = await upload(credentialA, retry);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 0, duplicates: 0, discarded: 2 });
    expect(await stored(ids.userA)).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
    expect(await chunkCount()).toBe(chunksBefore);
  });

  it("'Today' at midday: a late pre-delete segment is discarded, a later capture is kept", async () => {
    // Delete [start of day, D) with D thirty minutes ago.
    const deletedAt = new Date(Date.now() - 30 * MINUTE);
    await deleteRange(ids.userA, new Date(Date.now() - 10 * HOUR), null, deletedAt);

    const res = await upload(
      credentialA2,
      request([
        { start: -3 * HOUR }, // inside today's range, captured before the delete: discarded
        { start: -5 * MINUTE }, // captured after the delete: accepted
        { start: -12 * HOUR } // yesterday, before the range: not covered, accepted
      ])
    );
    expect(res.json()).toMatchObject({ accepted: 2, discarded: 1 });
    expect(await stored(ids.userA)).toHaveLength(2);
  });

  it.each([
    ["fast", 3 * MINUTE],
    ["slow", -3 * MINUTE]
  ])("a 3-minute-%s clock cannot bring back a deleted segment", async (_name, clockOffset) => {
    const base = Date.now();
    // The first upload, at server time base-2min (09:59 against a 10:01 retry), was stored with
    // its start shifted into server time and the Mac's raw stamp kept for the idempotency key.
    const first = request([{ start: -150_000, length: 20_000 }], { base, clockOffset });
    const segment = first.segments[0];
    if (!segment) throw new Error("no segment");
    await dataContext.withDataContext({ actorUserId: ids.userA, requestId: "bt-seed" }, (db) =>
      repo.insertSegments(db, ids.userA, [
        {
          deviceId: randomUUID(),
          startedAt: new Date(base - 150_000),
          endedAt: new Date(base - 130_000),
          appName: segment.appName,
          bundleId: segment.bundleId,
          windowTitle: segment.windowTitle,
          address: null,
          body: segment.body,
          bodyHash: createHash("sha256").update(segment.body, "utf8").digest(),
          clientStartedAt: new Date(segment.startedAt)
        }
      ])
    );
    // "Everything" is deleted at 10:00, one minute before the retry.
    await deleteRange(ids.userA, null, null, new Date(base - 60_000));
    expect(await stored(ids.userA)).toHaveLength(0);

    // The retry at 10:01: same raw stamps, new sentAt on the same wrong clock.
    const retry = { ...first, sentAt: new Date(Date.now() + clockOffset).toISOString() };
    const res = await upload(credentialA, retry);
    expect(res.json()).toMatchObject({ accepted: 0, discarded: 1, rejectedClock: 0 });

    // A capture after the deletion (server time 20 seconds ago) is accepted.
    const later = await upload(
      credentialA,
      request([{ start: -20_000, length: 10_000 }], { clockOffset })
    );
    expect(later.json()).toMatchObject({ accepted: 1, discarded: 0 });
    expect(await stored(ids.userA)).toHaveLength(1);
  });

  it("discards a second Mac's late upload from before 'Everything', and keeps what came after", async () => {
    await upload(credentialA, request([{ start: -50 * MINUTE }]));
    await deleteRange(ids.userA, null, null, new Date(Date.now() - 10 * MINUTE));

    const res = await upload(
      credentialA2,
      request([{ start: -60 * MINUTE }, { start: -5 * MINUTE }])
    );
    expect(res.json()).toMatchObject({ accepted: 1, discarded: 1 });
    const rows = await stored(ids.userA);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.started_at.getTime()).toBeGreaterThan(Date.now() - 6 * MINUTE);
  });
});

describe("the Mac's clock (decision 11)", () => {
  it("refuses a request whose sentAt is two hours off, either way", async () => {
    for (const sentAtOffset of [2 * HOUR, -2 * HOUR]) {
      const res = await upload(
        credentialA,
        request([{ start: -5 * MINUTE }], { sentAtOffset, clockOffset: 0 })
      );
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "backtrack_clock" });
    }
    expect(await stored()).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });

  it("counts a segment from 27 hours ago as rejectedClock, and stores the rest", async () => {
    const res = await upload(
      credentialA,
      request([{ start: -27 * HOUR }, { start: -25 * HOUR }, { start: -5 * MINUTE }])
    );
    expect(res.json()).toMatchObject({ accepted: 2, rejectedClock: 1 });
    expect(await stored(ids.userA)).toHaveLength(2);
  });

  it("counts a segment that ends in the future as rejectedClock", async () => {
    const res = await upload(credentialA, request([{ start: 5 * MINUTE }]));
    expect(res.json()).toMatchObject({ accepted: 0, rejectedClock: 1 });
  });

  it("treats a retry under a slightly different skew as a duplicate, not a second row", async () => {
    const base = Date.now();
    const batch = request([{ start: -10 * MINUTE }], { base });
    expect((await upload(credentialA, batch)).json()).toMatchObject({ accepted: 1 });

    // Network latency: same raw stamps, a different sentAt, so a different shifted start.
    const retry = { ...batch, sentAt: new Date(Date.now() - 1500).toISOString() };
    const res = await upload(credentialA, retry);
    expect(res.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await stored(ids.userA)).toHaveLength(1);
  });
});

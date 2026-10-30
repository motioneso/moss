import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { exportUserData } from "../../packages/settings/src/data-export.js";
import { sweepOutlookBrowserLifecycle } from "../../packages/connectors/src/outlook-lifecycle-worker.js";
import {
  OutlookSetupRepository,
  type OutlookLease,
  type OutlookSetupRow
} from "../../packages/connectors/src/outlook-setup-repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const identityA = "a".repeat(64);
const identityB = "b".repeat(64);
const ref = (row: OutlookSetupRow) => ({ runtimeId: row.runtime_id, generation: row.generation });

describe("Managed Outlook durable lifecycle", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let bootstrap: Kysely<MossDatabase>;
  let authDb: Kysely<MossDatabase>;
  let app: DataContextRunner;
  let worker: DataContextRunner;
  let now = new Date();
  const repo = new OutlookSetupRepository(() => now);
  const asA = <T>(work: (db: DataContextDb) => Promise<T>) =>
    app.withDataContext({ actorUserId: ids.userA }, work);

  const claimCleanup = async () =>
    (
      await sql<{ runtime_id: string; generation: number; claim_id: string }>`
      select * from app.claim_outlook_browser_cleanup()
    `.execute(workerDb)
    ).rows;
  const finishCleanup = async (runtimeId: string, claimId: string, removed: boolean) =>
    (
      await sql<{ done: boolean }>`
      select app.finish_outlook_browser_cleanup(${runtimeId}::uuid, ${claimId}::uuid, ${removed}) as done
    `.execute(workerDb)
    ).rows[0]!.done;

  async function fresh(): Promise<OutlookSetupRow> {
    const prior = await asA((db) => repo.get(db));
    if (prior && prior.state !== "removed") await asA((db) => repo.revoke(db, ref(prior)));
    for (const task of await claimCleanup())
      await finishCleanup(task.runtime_id, task.claim_id, true);
    now = new Date();
    return asA((db) => repo.start(db));
  }

  async function signedIn(): Promise<OutlookSetupRow> {
    const row = await fresh();
    await asA((db) => repo.ready(db, ref(row)));
    return (await asA((db) => repo.confirm(db, ref(row), identityA)))!;
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 3 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
    authDb = createDatabase({ connectionString: connectionStrings.auth });
    app = new DataContextRunner(appDb);
    worker = new DataContextRunner(workerDb);
  });
  afterAll(async () => {
    await Promise.allSettled([
      appDb?.destroy(),
      workerDb?.destroy(),
      bootstrap?.destroy(),
      authDb?.destroy()
    ]);
  });

  it("serializes first setup, resumes idempotently, and allocates independent owner resources", async () => {
    const [a1, a2, b] = await Promise.all([
      asA((db) => repo.start(db)),
      asA((db) => repo.start(db)),
      app.withDataContext({ actorUserId: ids.userB }, (db) => repo.start(db))
    ]);
    expect(a1.runtime_id).toBe(a2.runtime_id);
    expect(b.runtime_id).not.toBe(a1.runtime_id);
    expect(a1.state).toBe("preparing");
  });

  it("hides another owner's resource from ordinary users and admins with actual RLS", async () => {
    const a = await fresh();
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      await app.withDataContext({ actorUserId }, async (db) => {
        expect(
          await db.db
            .selectFrom("app.connector_outlook_setups")
            .selectAll()
            .where("runtime_id", "=", a.runtime_id)
            .execute()
        ).toEqual([]);
        expect(await repo.revoke(db, ref(a))).toBeUndefined();
        expect(await repo.ready(db, ref(a))).toBeUndefined();
      });
    }
    await expect(
      app.withDataContext({ actorUserId: ids.userB }, (db) =>
        db.db
          .insertInto("app.connector_outlook_setups")
          .values({ ...a, runtime_id: randomUUID() })
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("observes the owner-boundary assertion fail when RLS is disabled, then restores it", async () => {
    const a = await fresh();
    const assertHidden = () =>
      app.withDataContext({ actorUserId: ids.adminUser }, async (db) => {
        expect(
          await db.db
            .selectFrom("app.connector_outlook_setups")
            .select("runtime_id")
            .where("runtime_id", "=", a.runtime_id)
            .execute()
        ).toEqual([]);
      });
    await assertHidden();
    await sql`alter table app.connector_outlook_setups disable row level security`.execute(
      bootstrap
    );
    try {
      await expect(assertHidden()).rejects.toMatchObject({ name: "AssertionError" });
    } finally {
      await sql`alter table app.connector_outlook_setups enable row level security`.execute(
        bootstrap
      );
    }
    await assertHidden();
  });

  it("revokes expired unconfirmed setup durably and refuses replacement until cleanup", async () => {
    const a = await fresh();
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await asA((db) => repo.ready(db, ref(a)))).toBeUndefined();
    const expired = await asA((db) => repo.start(db));
    expect(expired.state).toBe("removing");
    expect(expired.generation).toBe(a.generation + 1);
    await expect(asA((db) => repo.start(db))).rejects.toMatchObject({ statusCode: 409 });
    const tasks = await claimCleanup();
    const task = tasks.find((t) => t.runtime_id === a.runtime_id)!;
    expect(task).toBeDefined();
    expect(await finishCleanup(task.runtime_id, task.claim_id, true)).toBe(true);
    const replacement = await asA((db) => repo.start(db));
    expect(replacement.runtime_id).not.toBe(a.runtime_id);
    expect(replacement.generation).toBeGreaterThan(expired.generation);
    expect(await asA((db) => repo.ready(db, ref(a)))).toBeUndefined();
  });

  it("keeps failed cleanup visible and durable, rejects stale acknowledgments, and retries", async () => {
    const a = await signedIn();
    await asA((db) => repo.revoke(db, ref(a)));
    const task = (await claimCleanup()).find((t) => t.runtime_id === a.runtime_id)!;
    expect(await finishCleanup(task.runtime_id, randomUUID(), true)).toBe(false);
    expect(await finishCleanup(task.runtime_id, task.claim_id, false)).toBe(true);
    expect((await asA((db) => repo.get(db)))?.state).toBe("cleanup-failed");
    await expect(asA((db) => repo.start(db))).rejects.toMatchObject({ statusCode: 409 });
    expect(await claimCleanup()).toEqual([]);
    await sql`update app.connector_outlook_cleanup set next_attempt_at = now() - interval '1 second'
      where runtime_id = ${a.runtime_id}::uuid`.execute(bootstrap);
    const retry = (await claimCleanup())[0]!;
    expect(retry.claim_id).not.toBe(task.claim_id);
    expect(await finishCleanup(task.runtime_id, task.claim_id, true)).toBe(false);
    expect(await finishCleanup(retry.runtime_id, retry.claim_id, true)).toBe(true);
    expect((await asA((db) => repo.get(db)))?.state).toBe("removed");
  });

  it("excludes interactive/collector overlap and rejects session and generation substitution", async () => {
    const a = await signedIn();
    const [first, second] = await Promise.all([
      asA((db) => repo.acquireLease(db, ref(a), { kind: "viewer", sessionId: ids.sessionA })),
      asA((db) => repo.acquireLease(db, ref(a), { kind: "collector" }))
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const lease = (first ?? second)!;
    expect(await asA((db) => repo.heartbeat(db, { ...lease, generation: a.generation - 1 }))).toBe(
      false
    );
    if (lease.kind === "viewer")
      expect(await asA((db) => repo.heartbeat(db, { ...lease, sessionId: ids.sessionB }))).toBe(
        false
      );
    expect(
      await worker.withDataContext({ actorUserId: ids.userB }, (db) => repo.heartbeat(db, lease))
    ).toBe(false);
    expect(await asA((db) => repo.releaseLease(db, lease))).toBe(true);
    const viewer = (await asA((db) =>
      repo.acquireLease(db, ref(a), { kind: "viewer", sessionId: ids.sessionA })
    ))!;
    expect(await asA((db) => repo.heartbeat(db, { ...viewer, sessionId: ids.sessionB }))).toBe(
      false
    );
    expect(await asA((db) => repo.releaseLease(db, { ...viewer, sessionId: ids.sessionB }))).toBe(
      false
    );
    await asA((db) => repo.revoke(db, ref(a)));
    expect(await asA((db) => repo.heartbeat(db, viewer, true))).toBe(false);
    expect(await asA((db) => repo.releaseLease(db, viewer))).toBe(false);
  });

  it("expires a missed heartbeat and old controllers cannot release a replacement lease", async () => {
    const a = await signedIn();
    const first = (await asA((db) =>
      repo.acquireLease(db, ref(a), { kind: "viewer", sessionId: ids.sessionA })
    ))!;
    now = new Date(now.getTime() + 46_000);
    expect(await asA((db) => repo.heartbeat(db, first))).toBe(false);
    const second = (await asA((db) => repo.acquireLease(db, ref(a), { kind: "collector" })))!;
    expect(second).toBeDefined();
    expect(await asA((db) => repo.releaseLease(db, first))).toBe(false);
    expect(await asA((db) => repo.heartbeat(db, second))).toBe(true);
  });

  it("enforces idle and absolute viewer expiry even when frame heartbeats continue", async () => {
    const a = await signedIn();
    let lease: OutlookLease = (await asA((db) =>
      repo.acquireLease(db, ref(a), { kind: "viewer", sessionId: ids.sessionA })
    ))!;
    for (let tick = 0; tick < 19; tick++) {
      now = new Date(now.getTime() + 15_000);
      expect(await asA((db) => repo.heartbeat(db, lease))).toBe(true);
    }
    now = new Date(now.getTime() + 15_000);
    expect(await asA((db) => repo.heartbeat(db, lease))).toBe(false);
    lease = (await asA((db) =>
      repo.acquireLease(db, ref(a), { kind: "viewer", sessionId: ids.sessionA })
    ))!;
    for (let tick = 0; tick < 119; tick++) {
      now = new Date(now.getTime() + 15_000);
      expect(await asA((db) => repo.heartbeat(db, lease, true))).toBe(true);
    }
    now = new Date(now.getTime() + 15_000);
    expect(await asA((db) => repo.heartbeat(db, lease, true))).toBe(false);
  });

  it("pauses changed or missing identity and only resumes the original account", async () => {
    const a = await signedIn();
    expect((await asA((db) => repo.verifyIdentity(db, ref(a), identityB)))?.state).toBe(
      "source-changed"
    );
    expect(await asA((db) => repo.acquireLease(db, ref(a), { kind: "collector" }))).toBeUndefined();
    expect(await asA((db) => repo.confirm(db, ref(a), identityB))).toBeUndefined();
    expect((await asA((db) => repo.verifyIdentity(db, ref(a), null)))?.state).toBe(
      "sign-in-needed"
    );
    expect((await asA((db) => repo.verifyIdentity(db, ref(a), identityA)))?.state).toBe("active");
    await asA((db) => repo.revoke(db, ref(a)));
    expect(await asA((db) => repo.verifyIdentity(db, ref(a), identityA))).toBeUndefined();
  });

  it("keeps runtime references and identity hashes out of the actual account export", async () => {
    const a = await signedIn();
    const exported = await asA((db) =>
      exportUserData({
        scopedDb: db,
        authDb,
        userId: ids.userA,
        listModuleManifests: getBuiltInModuleManifests
      })
    );
    const json = JSON.stringify(exported);
    expect(exported.userId).toBe(ids.userA);
    expect(json).not.toContain(a.runtime_id);
    expect(json).not.toContain(identityA);
    expect(json).not.toContain("lease_session_id");
  });

  it("recovers an abandoned setup and a crashed cleanup claim on the next worker sweep", async () => {
    const a = await fresh();
    await sql`update app.connector_outlook_setups set setup_expires_at = now() - interval '1 second'
      where runtime_id = ${a.runtime_id}::uuid`.execute(bootstrap);
    const calls: string[] = [];
    const runtime = {
      async remove(resource: { runtimeId: string }) {
        calls.push(resource.runtimeId);
        throw new Error("invented-runtime-unavailable");
      }
    };
    expect(await sweepOutlookBrowserLifecycle({ workerDb, dataContext: worker, runtime })).toEqual({
      removed: 0,
      pending: 1
    });
    expect(calls).toEqual([a.runtime_id]);
    expect((await asA((db) => repo.get(db)))?.state).toBe("cleanup-failed");
    await sql`update app.connector_outlook_cleanup set next_attempt_at = now() - interval '1 second'
      where runtime_id = ${a.runtime_id}::uuid`.execute(bootstrap);
    const crashed = (await claimCleanup())[0]!;
    await sql`update app.connector_outlook_cleanup set claim_expires_at = now() - interval '1 second'
      where runtime_id = ${a.runtime_id}::uuid`.execute(bootstrap);
    expect(await finishCleanup(crashed.runtime_id, crashed.claim_id, true)).toBe(false);
    expect(
      await sweepOutlookBrowserLifecycle({
        workerDb,
        dataContext: new DataContextRunner(workerDb),
        runtime: {
          async remove(resource) {
            calls.push(resource.runtimeId);
          }
        }
      })
    ).toEqual({ removed: 1, pending: 0 });
    expect((await asA((db) => repo.get(db)))?.state).toBe("removed");
    expect(calls).toEqual([a.runtime_id, a.runtime_id]);
  });

  it("survives owner deletion with only opaque cleanup metadata retained", async () => {
    const b = await app.withDataContext({ actorUserId: ids.userB }, (db) => repo.get(db));
    await sql`delete from app.users where id = ${ids.userB}::uuid`.execute(bootstrap);
    expect(
      await app.withDataContext({ actorUserId: ids.userB }, (db) => repo.get(db))
    ).toBeUndefined();
    const task = (await claimCleanup()).find((t) => t.runtime_id === b!.runtime_id)!;
    expect(task).toBeDefined();
    expect(Object.keys(task).sort()).toEqual(["claim_id", "generation", "runtime_id"]);
    expect(await finishCleanup(task.runtime_id, task.claim_id, true)).toBe(true);
    expect(await claimCleanup()).toEqual([]);
  });

  it("denies direct cleanup dispatch and cleanup-row reads to the app role", async () => {
    await expect(
      sql`select * from app.claim_outlook_browser_cleanup()`.execute(appDb)
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      sql`select * from app.connector_outlook_cleanup`.execute(appDb)
    ).rejects.toMatchObject({ code: "42501" });
  });
});

// #3720: atomic module job enqueue with duplicate, pending and hourly limits.
// Real pg-boss on the gate's scratch database. Run only through scripts/run-gate.sh.
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccessContext, MossDatabase } from "@moss/db";
import {
  createPgBossClient,
  enqueueModuleJobForActor,
  migratePgBoss,
  sendModuleJob,
  type ModuleEnqueueLimits
} from "@moss/jobs";

import {
  connectionStrings,
  ids,
  laneScopedModuleId,
  resetFoundationDatabase
} from "./test-database.js";

const { Client, Pool } = pg;

const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;
const MOD = laneScopedModuleId("enq");
const MAIN = { name: `${MOD}.main`, handler: "main", allowModuleEnqueue: true };
const SIDE = { name: `${MOD}.side`, handler: "side", allowModuleEnqueue: true };
const MODULE = {
  id: MOD,
  manifestHash: MANIFEST_HASH,
  queueNames: [MAIN.name, SIDE.name]
};
const LIMITS: ModuleEnqueueLimits = { pending: 10, hourly: 120 };
const SECRET_KEY = "plan:secret-marker-3720:day:3";

let boss: PgBoss;
let db: Kysely<MossDatabase>;
let pool: pg.Pool;

const actor = (id: string): AccessContext => ({ actorUserId: id });

async function bootstrap(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

function enqueue(
  actorUserId: string,
  key: string,
  options: { queue?: typeof MAIN; limits?: ModuleEnqueueLimits } = {}
) {
  return enqueueModuleJobForActor(
    boss,
    db,
    actor(actorUserId),
    MODULE,
    options.queue ?? MAIN,
    { jobKind: "step", idempotencyKey: key },
    options.limits ?? LIMITS
  );
}

async function sendDirect(actorUserId: string, queue = MAIN): Promise<void> {
  await sendModuleJob(boss, actor(actorUserId), MODULE, queue, { jobKind: "other" });
}

async function count(actorUserId: string, states: string[]): Promise<number> {
  const result = await bootstrap(
    `SELECT count(*)::int AS n FROM pgboss.job
     WHERE starts_with(name, $1) AND data->>'actorUserId' = $2 AND state = ANY($3::pgboss.job_state[])`,
    [`${MOD}.`, actorUserId, states]
  );
  return result.rows[0].n as number;
}

beforeEach(async () => {
  await resetFoundationDatabase();
  await migratePgBoss(connectionStrings.migration, [{ name: MAIN.name }, { name: SIDE.name }]);
  pool = new Pool({ connectionString: connectionStrings.worker, max: 6 });
  db = new Kysely<MossDatabase>({ dialect: new PostgresDialect({ pool }) });
  boss = createPgBossClient(connectionStrings.worker, { connectionTimeoutMillis: 25_000 });
  await boss.start();
}, 120_000);

afterEach(async () => {
  await boss.stop({ graceful: false });
  await db.destroy();
}, 60_000);

describe("enqueueModuleJobForActor (#3720)", () => {
  it("enqueues once, then reports the repeat as a duplicate", async () => {
    expect(await enqueue(ids.userA, "k1")).toEqual({ status: "enqueued" });
    expect(await enqueue(ids.userA, "k1")).toEqual({ status: "duplicate" });
    expect(await count(ids.userA, ["created"])).toBe(1);
  });

  it("7. a repeat call at the pending cap is a duplicate, not limited", async () => {
    expect(await enqueue(ids.userA, "first")).toEqual({ status: "enqueued" });
    for (let i = 0; i < 9; i += 1) await sendDirect(ids.userA);
    expect(await count(ids.userA, ["created"])).toBe(10);
    expect(await enqueue(ids.userA, "first")).toEqual({ status: "duplicate" });
    expect(await enqueue(ids.userA, "second")).toEqual({ status: "limited", limit: "pending" });
  });

  it("8. the same key from two users makes two jobs", async () => {
    expect(await enqueue(ids.userA, "shared")).toEqual({ status: "enqueued" });
    expect(await enqueue(ids.userB, "shared")).toEqual({ status: "enqueued" });
    expect(await count(ids.userA, ["created"])).toBe(1);
    expect(await count(ids.userB, ["created"])).toBe(1);
  });

  it("9. the 11th pending job is limited, counting every queue and every origin", async () => {
    for (let i = 0; i < 5; i += 1) await sendDirect(ids.userA);
    for (let i = 0; i < 4; i += 1) await sendDirect(ids.userA, SIDE);
    expect(await enqueue(ids.userA, "tenth")).toEqual({ status: "enqueued" });
    expect(await enqueue(ids.userA, "eleventh", { queue: SIDE })).toEqual({
      status: "limited",
      limit: "pending"
    });
    expect(await count(ids.userA, ["created"])).toBe(10);
  });

  it("10. another user's pending jobs do not count", async () => {
    for (let i = 0; i < 10; i += 1) await sendDirect(ids.userB);
    expect(await enqueue(ids.userA, "mine")).toEqual({ status: "enqueued" });
    expect(await enqueue(ids.userB, "theirs")).toEqual({ status: "limited", limit: "pending" });
  });

  it("11. the hourly limit holds at its boundary", async () => {
    const limits = { pending: 1_000, hourly: 5 };
    for (let i = 0; i < 5; i += 1) {
      expect(await enqueue(ids.userA, `h${i}`, { limits })).toEqual({ status: "enqueued" });
    }
    expect(await enqueue(ids.userA, "h5", { limits })).toEqual({
      status: "limited",
      limit: "hourly"
    });

    // A row older than 3,600 seconds leaves the window.
    await bootstrap(
      `UPDATE pgboss.job SET created_on = now() - interval '3601 seconds'
       WHERE id = (SELECT id FROM pgboss.job WHERE starts_with(name, $1) ORDER BY id LIMIT 1)`,
      [`${MOD}.`]
    );
    expect(await enqueue(ids.userA, "h6", { limits })).toEqual({ status: "enqueued" });
    expect(await enqueue(ids.userA, "h7", { limits })).toEqual({
      status: "limited",
      limit: "hourly"
    });

    // A row just inside the window still counts.
    await bootstrap(
      `UPDATE pgboss.job SET created_on = now() - interval '3599 seconds'
       WHERE id = (SELECT id FROM pgboss.job WHERE starts_with(name, $1)
                   AND created_on > now() - interval '60 seconds' ORDER BY id LIMIT 1)`,
      [`${MOD}.`]
    );
    expect(await enqueue(ids.userA, "h8", { limits })).toEqual({
      status: "limited",
      limit: "hourly"
    });

    // A cancelled row does not count.
    await bootstrap(
      `UPDATE pgboss.job SET state = 'cancelled'
       WHERE id = (SELECT id FROM pgboss.job WHERE starts_with(name, $1)
                   AND state = 'created' AND created_on > now() - interval '1800 seconds'
                   ORDER BY id LIMIT 1)`,
      [`${MOD}.`]
    );
    expect(await enqueue(ids.userA, "h9", { limits })).toEqual({ status: "enqueued" });
  });

  it("counts a job sent through sendModuleJob toward both limits", async () => {
    await sendDirect(ids.userA);
    expect(await enqueue(ids.userA, "p", { limits: { pending: 1, hourly: 100 } })).toEqual({
      status: "limited",
      limit: "pending"
    });
    expect(await enqueue(ids.userA, "h", { limits: { pending: 100, hourly: 1 } })).toEqual({
      status: "limited",
      limit: "hourly"
    });
  });

  it("13. two concurrent calls at nine pending give one enqueued and one limited", async () => {
    for (let i = 0; i < 9; i += 1) await sendDirect(ids.userA);
    const results = await Promise.all([enqueue(ids.userA, "race-a"), enqueue(ids.userA, "race-b")]);
    expect(results.map((r) => r.status).sort()).toEqual(["enqueued", "limited"]);
    expect(await count(ids.userA, ["created"])).toBe(10);
  });

  it("17. the row holds only the envelope keys and never the key text", async () => {
    expect(await enqueue(ids.userA, SECRET_KEY)).toEqual({ status: "enqueued" });
    const rows = await bootstrap(
      `SELECT to_jsonb(j)::text AS everything, data FROM pgboss.job j WHERE starts_with(name, $1)`,
      [`${MOD}.`]
    );
    expect(rows.rows).toHaveLength(1);
    expect(Object.keys(rows.rows[0].data).sort()).toEqual([
      "actorUserId",
      "jobKind",
      "manifestHash",
      "moduleId"
    ]);
    expect(rows.rows[0].everything).not.toContain("secret-marker-3720");
  });

  it("rejects a malformed kind or key with a generic error that omits the key", async () => {
    const badKey = "bad key with spaces secret-marker-3720";
    const attempt = enqueue(ids.userA, badKey);
    await expect(attempt).rejects.toThrow();
    await attempt.catch((error: Error) => {
      expect(error.message).not.toContain("secret-marker-3720");
    });
    await expect(
      enqueueModuleJobForActor(
        boss,
        db,
        actor(ids.userA),
        MODULE,
        MAIN,
        { jobKind: "Bad Kind", idempotencyKey: "ok-key" },
        LIMITS
      )
    ).rejects.toThrow();
    expect(await count(ids.userA, ["created"])).toBe(0);
  });
});

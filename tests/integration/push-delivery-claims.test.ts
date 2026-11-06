import { afterAll, beforeAll, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { PushDeliveryClaimsRepository } from "../../packages/notifications/src/push-delivery-claims.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let root: Kysely<MossDatabase>;
let runner: DataContextRunner;
const claims = new PushDeliveryClaimsRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  root = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  runner = new DataContextRunner(root);
});
afterAll(async () => {
  await root?.destroy();
});

function asActor<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>) {
  return runner.withDataContext({ actorUserId }, work);
}

it("commits an exclusive claim, recovers an expired attempt and fences its old finalizer", async () => {
  const key = "notification-claim";
  const token = await asActor(ids.userA, (db) => claims.claim(db, key));
  expect(token).toBeDefined();
  expect(await asActor(ids.userA, (db) => claims.claim(db, key))).toBeUndefined();
  await asActor(ids.userA, (db) =>
    sql`
    UPDATE app.push_delivery_claims SET expires_at = clock_timestamp() - interval '1 second'
    WHERE delivery_key = ${key}
  `.execute(db.db)
  );
  const replacement = await asActor(ids.userA, (db) => claims.claim(db, key));
  expect(replacement).toBeDefined();
  expect(replacement).not.toBe(token);
  expect(await asActor(ids.userA, (db) => claims.release(db, key, token!))).toBe(false);
  expect(await asActor(ids.userA, (db) => claims.release(db, key, replacement!))).toBe(true);
  expect(await asActor(ids.userA, (db) => claims.claim(db, key))).toBeDefined();
});

it("isolates claims and finalization by recipient, including concurrent admission", async () => {
  const key = "shared-key";
  const attempts = await Promise.all([
    asActor(ids.userA, (db) => claims.claim(db, key)),
    asActor(ids.userA, (db) => claims.claim(db, key))
  ]);
  const token = attempts.find((value) => value !== undefined)!;
  expect(attempts.filter(Boolean)).toHaveLength(1);
  await asActor(ids.userB, async (db) => {
    const rows =
      await sql`SELECT token FROM app.push_delivery_claims WHERE token = ${token}::uuid`.execute(
        db.db
      );
    expect(rows.rows).toHaveLength(0);
    const deleted =
      await sql`DELETE FROM app.push_delivery_claims WHERE token = ${token}::uuid RETURNING token`.execute(
        db.db
      );
    expect(deleted.rows).toHaveLength(0);
  });
  expect(await asActor(ids.userB, (db) => claims.release(db, key, token))).toBe(false);
  const otherToken = await asActor(ids.userB, (db) => claims.claim(db, key));
  expect(otherToken).toBeDefined();
  expect(await asActor(ids.userA, (db) => claims.release(db, key, token))).toBe(true);
  expect(await asActor(ids.userB, (db) => claims.release(db, key, otherToken!))).toBe(true);
});

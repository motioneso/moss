import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  BriefingRunDeadlineError,
  withRunDeadline
} from "../../packages/briefings/src/run-deadline.js";

import { connectionStrings, ids } from "./test-database.js";

// Arbitrary key for a transaction-scoped lock that stands in for the row lock a hung run held.
const LOCK_KEY = 2671_2671;

describe("briefing run deadline releases the transaction (#2671)", () => {
  let appDb: Kysely<MossDatabase>;

  beforeAll(() => {
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  it("rolls back and frees its locks when a step never finishes", async () => {
    const runner = new DataContextRunner(appDb);

    const hung = runner.withDataContext({ actorUserId: ids.userA, requestId: "deadline" }, (db) =>
      withRunDeadline(async () => {
        await sql`select pg_advisory_xact_lock(${LOCK_KEY})`.execute(db.db);
        return new Promise<never>(() => undefined);
      }, 300)
    );
    await expect(hung).rejects.toBeInstanceOf(BriefingRunDeadlineError);

    // A second connection can take the lock only if the hung run's transaction is gone.
    const got = await appDb.transaction().execute(async (tx) => {
      const probe = await sql<{
        got: boolean;
      }>`select pg_try_advisory_xact_lock(${LOCK_KEY}) as got`.execute(tx);
      return probe.rows[0]?.got;
    });
    expect(got).toBe(true);
  });
});

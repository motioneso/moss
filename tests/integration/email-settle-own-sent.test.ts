import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { EmailRepository } from "@moss/email";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

/**
 * #2878 - rows an earlier sync marked as waiting for a decision, but that the user sent from
 * their own address, are settled. Other senders and other owners keep their mark.
 */
const accountA = "60000000-0000-4000-8000-000000000001";
const accountB = "60000000-0000-4000-8000-000000000002";
const ownSent = "60000000-0000-4000-8000-00000000000a";
const fromOther = "60000000-0000-4000-8000-00000000000b";
const otherOwner = "60000000-0000-4000-8000-00000000000c";

const PENDING = JSON.stringify({ pendingJudgement: true, confidence: 0.9 });

async function seed(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app.connector_accounts
         (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
       VALUES
         ($1, 'google-email', $2, ARRAY['gmail.readonly']::text[], 'active', '{}'::jsonb),
         ($3, 'google-email', $4, ARRAY['gmail.readonly']::text[], 'active', '{}'::jsonb)`,
      [accountA, ids.userA, accountB, ids.userB]
    );
    await client.query(
      `INSERT INTO app.email_messages
         (id, connector_account_id, owner_user_id, sender, subject, received_at,
          external_id, summary, signals)
       VALUES
         ($1, $2, $3, 'Me <me@example.test>', 'Re: Follow up', now(), 'e1', null, $7::jsonb),
         ($4, $2, $3, 'boss@example.test', 'Question', now(), 'e2', null, $7::jsonb),
         ($5, $6, $8, 'me@example.test', 'Other owner', now(), 'e3', null, $7::jsonb)`,
      [ownSent, accountA, ids.userA, fromOther, otherOwner, accountB, PENDING, ids.userB]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

describe("settling own sent mail that is marked as waiting", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const repository = new EmailRepository();

  beforeAll(async () => {
    await resetFoundationDatabase();
    await seed();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb?.destroy();
  });

  const signalsOf = (actor: string, id: string) =>
    dataContext.withDataContext({ actorUserId: actor, requestId: randomUUID() }, (scopedDb) =>
      scopedDb.db
        .selectFrom("app.email_messages")
        .select("signals")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    );

  it("settles the owner's own sent row and leaves everything else marked", async () => {
    const settled = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: randomUUID() },
      (scopedDb) =>
        repository.settleOwnSentAwaiting(scopedDb, ids.userA, new Set(["me@example.test"]))
    );
    expect(settled).toBe(1);

    expect((await signalsOf(ids.userA, ownSent)).signals).toEqual({
      skipped: "own_sent",
      confidence: 1
    });
    expect((await signalsOf(ids.userA, fromOther)).signals).toMatchObject({
      pendingJudgement: true
    });
    expect((await signalsOf(ids.userB, otherOwner)).signals).toMatchObject({
      pendingJudgement: true
    });
  });
});

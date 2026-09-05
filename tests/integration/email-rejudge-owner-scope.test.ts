import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { EmailRepository } from "@moss/email";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

/**
 * #2271 round 2 — the re-judge reset must not reach another owner's mail.
 *
 * The UPDATE policy on app.email_messages admits rows shared to the actor at 'manage' level, so
 * relying on the row rules alone would let user A's re-judge empty the stored verdict on user B's
 * shared message. Only A's mailbox would then be re-synced, leaving B's copy blank for good. The
 * repository names the owner explicitly; this proves it end to end against Postgres.
 */
const accountA = "50000000-0000-4000-8000-000000000001";
const accountB = "50000000-0000-4000-8000-000000000002";
const messageA = "50000000-0000-4000-8000-00000000000a";
const messageB = "50000000-0000-4000-8000-00000000000b";

const STORED_SIGNALS = {
  actionability: {
    category: "needs_action",
    inferredSubject: "A stored verdict",
    suggestedTasks: [{ text: "Do the thing" }]
  }
};

async function seed(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO app.connector_accounts
          (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
        VALUES
          ($1, 'google-email', $2, ARRAY['gmail.readonly']::text[], 'active', '{}'::jsonb),
          ($3, 'google-email', $4, ARRAY['gmail.readonly']::text[], 'active', '{}'::jsonb)
      `,
      [accountA, ids.userA, accountB, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.email_messages
          (id, connector_account_id, owner_user_id, sender, subject, received_at,
           external_id, summary, signals)
        VALUES
          ($1, $2, $3, 'a@example.test', 'Mail user A owns', now(), 'ext-a', $5, $6::jsonb),
          ($4, $7, $8, 'b@example.test', 'Mail user B owns', now(), 'ext-b', $5, $6::jsonb)
      `,
      [
        messageA,
        accountA,
        ids.userA,
        messageB,
        "A stored summary",
        JSON.stringify(STORED_SIGNALS),
        accountB,
        ids.userB
      ]
    );
    // User B hands user A the strongest sharing level there is.
    await client.query(
      `
        INSERT INTO app.shares
          (resource_type, resource_id, owner_user_id, grantee_user_id, level)
        VALUES ('email_message', $1::uuid, $2::uuid, $3::uuid, 'manage')
      `,
      [messageB, ids.userB, ids.userA]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

describe("re-judging email stays inside the actor's own mail", () => {
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

  it("clears user A's own message and leaves the message user B shared with A untouched", async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const cleared = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: randomUUID() },
      (scopedDb) => repository.clearRecentTriage(scopedDb, since)
    );
    expect(cleared).toBe(1);

    const own = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: randomUUID() },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.email_messages")
          .select(["summary", "signals"])
          .where("id", "=", messageA)
          .executeTakeFirstOrThrow()
    );
    expect(own.summary).toBeNull();
    expect(own.signals).toEqual({});

    // Read as the owner, so this is what user B still sees in their own mailbox.
    const shared = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: randomUUID() },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.email_messages")
          .select(["summary", "signals"])
          .where("id", "=", messageB)
          .executeTakeFirstOrThrow()
    );
    expect(shared.summary).toBe("A stored summary");
    expect(shared.signals).toEqual(STORED_SIGNALS);
  });
});

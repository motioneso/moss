import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { EmailRepository } from "@moss/email";
import { createEmailThreadProvider } from "../../packages/email/src/thread-provider.js";
import { CommitmentsRepository } from "../../packages/commitments/src/repository.js";
import { judgeEmailThread } from "../../packages/commitments/src/email-judgement-worker.js";
import { buildMorningEmailLines } from "../../packages/briefings/src/morning-inputs.js";
import { buildEmailCatchUp } from "../../packages/briefings/src/action-rows.js";

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
  it("keeps an answered grouped thread off both Today lists before and after judgement", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `UPDATE app.email_messages SET external_metadata='{"threadId":"answered"}'::jsonb,
        recipients=ARRAY['me@example.test'], received_at=now()-interval '60 days',
        signals='{"pendingJudgement":true,"actionability":{"category":"needs_reply"}}'::jsonb WHERE id=$1`,
        [fromOther]
      );
      await client.query(
        `UPDATE app.email_messages SET external_metadata='{"threadId":"answered"}'::jsonb,
        recipients=ARRAY['boss@example.test'], received_at=now(), signals='{"skipped":"own_sent"}'::jsonb WHERE id=$1`,
        [ownSent]
      );
      for (let i = 0; i < 5; i++)
        await client.query(
          `INSERT INTO app.email_messages
        (id,connector_account_id,owner_user_id,sender,recipients,subject,received_at,external_id,signals)
        VALUES ($1,$2,$3,'shop@example.test',ARRAY['me@example.test'],'Receipt',now(),$4,'{"actionability":{"category":"noise"}}'::jsonb)`,
          [randomUUID(), accountA, ids.userA, `receipt-${i}`]
        );
    } finally {
      await client.end();
    }
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: randomUUID() },
      async (db) => {
        const assertOffToday = async () => {
          const rows = await repository.listVisibleForBriefing(db);
          const question = rows.find((row) => row.id === fromOther)!;
          expect(question.signals).toMatchObject({
            skipped: "answered_thread",
            pendingJudgement: false
          });
          const items = rows.map((row) => {
            const signals = row.signals as {
              pendingJudgement?: boolean;
              actionability?: { category: string };
            };
            return {
              id: row.external_id,
              connectorAccountId: row.connector_account_id,
              sender: row.sender,
              subject: row.subject,
              summary: row.summary,
              receivedAt: new Date(row.received_at).toISOString(),
              actionability: signals.actionability?.category ?? "unknown",
              awaitingJudgement: signals.pendingJudgement === true
            };
          });
          expect(buildMorningEmailLines({ items, signals: [], suggestionLines: [] }).lines).toEqual(
            []
          );
          expect(
            await buildEmailCatchUp(db, items, new Set(), undefined, {
              since: null,
              includes: () => true
            })
          ).toBeNull();
        };
        await assertOffToday();
        const generate = vi.fn();
        const threads = createEmailThreadProvider(
          repository,
          async () => new Set(["me@example.test"])
        );
        expect(
          await judgeEmailThread(
            db,
            { actorUserId: ids.userA, threadRef: "answered", idempotencyKey: "answered" },
            { repository: new CommitmentsRepository(), threads, context: {}, generate }
          )
        ).toBe("no_item");
        expect(generate).not.toHaveBeenCalled();
        await assertOffToday();
      }
    );
  });
});

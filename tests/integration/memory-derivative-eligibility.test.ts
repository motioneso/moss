import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, DataContextRunner } from "@moss/db";
import { MemoryGraphRepository } from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
beforeAll(async () => {
  await resetFoundationDatabase();
});
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy()]);
});

describe("local derivative eligibility", () => {
  it.each(["app", "worker"] as const)(
    "checks current side/revision and filters retired targets under %s",
    async (role) => {
      const runner = new DataContextRunner(role === "app" ? appDb : workerDb);
      const graph = new MemoryGraphRepository();
      const owner = { actorUserId: ids.userA };
      const receiptId = randomBytes(32).toString("hex");
      const identity = await runner.withDataContext(owner, async (db) => {
        const self = await graph.ensureSelfEntity(db, ids.userA);
        const episode = await graph.createEpisode(db, ids.userA, {
          sourceKind: "note",
          sourceRef: `recording:${randomUUID()}`,
          sourceLabel: "Synthetic recording",
          excerpt: "Same exact current text"
        });
        const fact = await graph.createFactFromEpisode(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "works_on",
          objectText: "Same exact current text",
          episodeId: episode.id
        });
        await sql`INSERT INTO app.memory_recording_fact_versions(owner_user_id,fact_id,lineage_id,side)
          VALUES (${ids.userA}::uuid,${fact.id}::uuid,${fact.id}::uuid,'personal')`.execute(db.db);
        await sql`UPDATE app.memory_facts SET recording_side = 'personal'
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${fact.id}::uuid`.execute(db.db);
        await sql`UPDATE app.memory_episodes SET recording_side = 'personal',recording_active = true
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${episode.id}::uuid`.execute(db.db);
        await sql`INSERT INTO app.memory_recording_receipts(owner_user_id,receipt_id,source_module_id,
          source_id,source_version,item_key,source_generation,side,state,fact_id,episode_id)
          VALUES (${ids.userA}::uuid,${receiptId},'meetings',${randomUUID()}::uuid,1,'derivative',0,
            'personal','applied',${fact.id}::uuid,${episode.id}::uuid)`.execute(db.db);
        const version = await sql<{
          revision: string;
        }>`SELECT revision FROM app.memory_recording_fact_versions
          WHERE owner_user_id = ${ids.userA}::uuid AND fact_id = ${fact.id}::uuid`.execute(db.db);
        const revision = version.rows[0]?.revision;
        expect(revision).toBeDefined();
        await sql`UPDATE app.memory_search_documents SET recording_side = 'personal',recording_revision = ${revision}::bigint
          WHERE owner_user_id = ${ids.userA}::uuid AND target_id IN (${fact.id}::uuid,${episode.id}::uuid)`.execute(
          db.db
        );
        return { factId: fact.id, episodeId: episode.id, revision };
      });
      await runner.withDataContext(owner, async (db) => {
        await sql`UPDATE app.memory_recording_fact_versions SET side = 'work'
          WHERE owner_user_id = ${ids.userA}::uuid AND fact_id = ${identity.factId}::uuid`.execute(
          db.db
        );
        await sql`UPDATE app.memory_facts SET recording_side = 'work'
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${identity.factId}::uuid`.execute(
          db.db
        );
        await sql`UPDATE app.memory_recording_receipts SET side = 'work',revision = revision + 1,source_generation = 1
          WHERE owner_user_id = ${ids.userA}::uuid AND receipt_id = ${receiptId}`.execute(db.db);
        await sql`UPDATE app.memory_episodes SET recording_side = 'work'
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${identity.episodeId}::uuid`.execute(
          db.db
        );
        await sql`UPDATE app.memory_search_documents SET recording_side = 'work',recording_revision = (
          SELECT revision FROM app.memory_recording_fact_versions WHERE owner_user_id = ${ids.userA}::uuid
            AND fact_id = ${identity.factId}::uuid)
          WHERE owner_user_id = ${ids.userA}::uuid AND target_id IN (${identity.factId}::uuid,${identity.episodeId}::uuid)`.execute(
          db.db
        );
      });
      await expect(
        runner.withDataContext(owner, async (db) => {
          await sql`UPDATE app.memory_search_documents SET recording_revision = ${identity.revision}::bigint
          WHERE owner_user_id = ${ids.userA}::uuid AND target_id = ${identity.factId}::uuid`.execute(
            db.db
          );
        })
      ).rejects.toThrow("Recording search activation is stale");
      await runner.withDataContext(owner, async (db) => {
        const before = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM app.memory_search_documents
          WHERE owner_user_id = ${ids.userA}::uuid AND target_id IN (${identity.factId}::uuid,${identity.episodeId}::uuid)
            AND app.memory_recording_target_revision(owner_user_id,target_kind,target_id,recording_side) = recording_revision`.execute(
          db.db
        );
        expect(before.rows[0]?.count).toBe(2);
        await sql`UPDATE app.memory_facts SET status = 'superseded' WHERE owner_user_id = ${ids.userA}::uuid AND id = ${identity.factId}::uuid`.execute(
          db.db
        );
        // Simulate a pre-existing active episode copy. Retirement does not mutate documents
        // in SQL; owning recall must independently require current target eligibility.
        const raw = await sql<{ status: string }>`SELECT status FROM app.memory_search_documents
          WHERE owner_user_id = ${ids.userA}::uuid AND target_id = ${identity.episodeId}::uuid`.execute(
          db.db
        );
        expect(raw.rows[0]?.status).toBe("active");
        const after = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM app.memory_search_documents
          WHERE owner_user_id = ${ids.userA}::uuid AND target_id IN (${identity.factId}::uuid,${identity.episodeId}::uuid)
            AND app.memory_recording_target_revision(owner_user_id,target_kind,target_id,recording_side) = recording_revision`.execute(
          db.db
        );
        expect(after.rows[0]?.count).toBe(0);
      });
      await expect(
        runner.withDataContext(owner, (db) =>
          sql`UPDATE app.memory_search_documents SET status = 'active',search_text = 'Late text from before retirement'
          WHERE owner_user_id = ${ids.userA}::uuid AND target_kind = 'fact' AND target_id = ${identity.factId}::uuid`.execute(
            db.db
          )
        )
      ).rejects.toThrow("Recording search activation is stale");
      await expect(
        runner.withDataContext(owner, async (db) => {
          await sql`UPDATE app.memory_episodes SET recording_active = true
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${identity.episodeId}::uuid`.execute(
            db.db
          );
        })
      ).rejects.toThrow("Recording episode activation is stale");
      await expect(
        runner.withDataContext(owner, async (db) => {
          await sql`UPDATE app.memory_search_documents SET recording_side = NULL,recording_revision = NULL
          WHERE owner_user_id = ${ids.userA}::uuid AND target_id = ${identity.factId}::uuid`.execute(
            db.db
          );
        })
      ).rejects.toThrow("Recording derivative label cannot be removed");
    }
  );
});

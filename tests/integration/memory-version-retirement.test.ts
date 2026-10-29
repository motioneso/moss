import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, DataContextRunner } from "@moss/db";
import { MemoryGraphRepository } from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
const inspection = createDatabase({
  connectionString: connectionStrings.bootstrap,
  maxConnections: 1
});
beforeAll(async () => {
  await resetFoundationDatabase();
});
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy(), inspection.destroy()]);
});

describe("Memory version retirement backstop", () => {
  it.each(["app", "worker"] as const)(
    "supports invoker-role entity and account cascades under %s",
    async (role) => {
      const runner = new DataContextRunner(role === "app" ? appDb : workerDb);
      const actorUserId = role === "app" ? ids.userC : ids.userD;
      const graph = new MemoryGraphRepository();
      const createManaged = async (subject: string, text: string) =>
        runner.withDataContext({ actorUserId }, async (db) => {
          const fact = await graph.createFact(db, actorUserId, {
            subjectEntityId: subject,
            predicate: "works_on",
            objectText: text,
            source: { sourceKind: "manual", sourceRef: `manual:${randomUUID()}`, excerpt: text }
          });
          await graph.deactivateSearchDocument(db, actorUserId, "fact", fact.id);
          await sql`
          INSERT INTO app.memory_recording_fact_versions(owner_user_id,fact_id,lineage_id,side)
          VALUES (${actorUserId}::uuid,${fact.id}::uuid,${fact.id}::uuid,'work')
        `.execute(db.db);
          await sql`UPDATE app.memory_facts SET recording_side = 'work'
          WHERE owner_user_id = ${actorUserId}::uuid AND id = ${fact.id}::uuid`.execute(db.db);
          return fact.id;
        });
      const entity = await runner.withDataContext({ actorUserId }, (db) =>
        graph.createEntity(db, actorUserId, {
          kind: "project",
          name: `Synthetic cascade ${randomUUID()}`
        })
      );
      const first = await createManaged(entity.id, "Synthetic entity cascade fact");
      await runner.withDataContext({ actorUserId }, async (db) => {
        await sql`DELETE FROM app.memory_entities
          WHERE owner_user_id = ${actorUserId}::uuid AND id = ${entity.id}::uuid`.execute(db.db);
        const retired = await sql<{
          state: string;
        }>`SELECT state FROM app.memory_recording_fact_versions
          WHERE owner_user_id = ${actorUserId}::uuid AND fact_id = ${first}::uuid`.execute(db.db);
        expect(retired.rows).toEqual([{ state: "forgotten" }]);
      });
      const self = await runner.withDataContext({ actorUserId }, (db) =>
        graph.ensureSelfEntity(db, actorUserId)
      );
      const second = await createManaged(self.id, "Synthetic account cascade fact");
      await runner.withDataContext({ actorUserId }, async (db) => {
        await sql`INSERT INTO app.memory_recording_receipts(owner_user_id,receipt_id,source_module_id,
          source_id,source_version,item_key,source_generation,side,state,fact_id,episode_id)
          VALUES (${actorUserId}::uuid,${randomBytes(32).toString("hex")},'meetings',${randomUUID()}::uuid,
            1,'cascade',0,'work','pending',${second}::uuid,${randomUUID()}::uuid)`.execute(db.db);
      });
      await sql`DELETE FROM app.users WHERE id = ${actorUserId}::uuid`.execute(inspection);
      const remaining = await sql<{ count: number }>`SELECT count(*)::int AS count
        FROM app.memory_recording_fact_versions WHERE owner_user_id = ${actorUserId}::uuid`.execute(
        inspection
      );
      expect(remaining.rows[0]?.count).toBe(0);
      const receipts = await sql<{ count: number }>`SELECT count(*)::int AS count
        FROM app.memory_recording_receipts WHERE owner_user_id = ${actorUserId}::uuid`.execute(
        inspection
      );
      expect(receipts.rows[0]?.count).toBe(0);
    }
  );

  it.each(["app", "worker"] as const)(
    "keeps a predecessor retired after its replacement is deleted under %s",
    async (role) => {
      const runner = new DataContextRunner(role === "app" ? appDb : workerDb);
      const graph = new MemoryGraphRepository();
      const owner = { actorUserId: ids.userA };
      const identity = await runner.withDataContext(owner, async (db) => {
        const self = await graph.ensureSelfEntity(db, ids.userA);
        const seed = async (text: string, root?: string) => {
          const fact = await graph.createFact(db, ids.userA, {
            subjectEntityId: self.id,
            predicate: "works_on",
            objectText: text,
            source: { sourceKind: "manual", sourceRef: `manual:${randomUUID()}`, excerpt: text }
          });
          await graph.deactivateSearchDocument(db, ids.userA, "fact", fact.id);
          await sql`
            INSERT INTO app.memory_recording_fact_versions(owner_user_id,fact_id,lineage_id,side)
            VALUES (${ids.userA}::uuid,${fact.id}::uuid,${root ?? fact.id}::uuid,'personal')
          `.execute(db.db);
          await sql`
            UPDATE app.memory_facts SET recording_side = 'personal'
            WHERE owner_user_id = ${ids.userA}::uuid AND id = ${fact.id}::uuid
          `.execute(db.db);
          return fact;
        };
        const original = await seed("Original synthetic recording fact");
        const replacement = await seed("Corrected synthetic recording fact", original.id);
        await sql`
          UPDATE app.memory_facts SET status = 'superseded',superseded_by_fact_id = ${replacement.id}::uuid
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${original.id}::uuid
        `.execute(db.db);
        // Exercise the database retirement backstop directly; source-service forgetting is
        // covered separately through both authenticated production paths.
        await sql`DELETE FROM app.memory_facts WHERE owner_user_id = ${ids.userA}::uuid
          AND id = ${replacement.id}::uuid`.execute(db.db);
        const predecessor = await sql<{ status: string; superseded_by_fact_id: string | null }>`
          SELECT status,superseded_by_fact_id FROM app.memory_facts
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${original.id}::uuid
        `.execute(db.db);
        expect(predecessor.rows[0]).toEqual({ status: "superseded", superseded_by_fact_id: null });
        const versions = await sql<{ fact_id: string; state: string }>`
          SELECT fact_id,state FROM app.memory_recording_fact_versions
          WHERE owner_user_id = ${ids.userA}::uuid AND fact_id IN (${original.id}::uuid,${replacement.id}::uuid)
        `.execute(db.db);
        expect(versions.rows).toEqual(
          expect.arrayContaining([
            { fact_id: original.id, state: "superseded" },
            { fact_id: replacement.id, state: "forgotten" }
          ])
        );
        return { original: original.id, replacement: replacement.id, subject: self.id };
      });
      await expect(
        runner.withDataContext(owner, (db) =>
          sql`UPDATE app.memory_facts SET status = 'active' WHERE owner_user_id = ${ids.userA}::uuid AND id = ${identity.original}::uuid`.execute(
            db.db
          )
        )
      ).rejects.toThrow("Retired recording fact cannot be activated");
      await expect(
        runner.withDataContext(owner, (db) =>
          sql`UPDATE app.memory_facts SET status = 'active',provenance = 'confirmed' WHERE owner_user_id = ${ids.userA}::uuid AND id = ${identity.original}::uuid`.execute(
            db.db
          )
        )
      ).rejects.toThrow("Retired recording fact cannot be activated");
      await expect(
        runner.withDataContext(owner, async (db) => {
          await sql`
          UPDATE app.memory_recording_fact_versions SET state = 'current'
          WHERE owner_user_id = ${ids.userA}::uuid AND fact_id = ${identity.replacement}::uuid
        `.execute(db.db);
        })
      ).rejects.toThrow("Recording fact history cannot be reset");
      await expect(
        runner.withDataContext(owner, async (db) => {
          await sql`
          UPDATE app.memory_facts SET recording_side = NULL
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${identity.original}::uuid
        `.execute(db.db);
        })
      ).rejects.toThrow("Recording fact label cannot be removed");
      await expect(
        runner.withDataContext(owner, async (db) => {
          await sql`
          INSERT INTO app.memory_facts(id,owner_user_id,subject_entity_id,predicate,object_text)
          VALUES (${identity.replacement}::uuid,${ids.userA}::uuid,${identity.subject}::uuid,'works_on','Attempted revival')
        `.execute(db.db);
        })
      ).rejects.toThrow("Retired recording fact cannot be activated");
      for (const actorUserId of [ids.userB, ids.adminUser]) {
        await runner.withDataContext({ actorUserId }, async (db) => {
          const hidden = await sql`
            SELECT fact_id FROM app.memory_recording_fact_versions
            WHERE owner_user_id = ${ids.userA}::uuid
          `.execute(db.db);
          expect(hidden.rows).toEqual([]);
          const changed = await sql`
            UPDATE app.memory_recording_fact_versions SET revision = revision + 1
            WHERE owner_user_id = ${ids.userA}::uuid
          `.execute(db.db);
          expect(changed.numAffectedRows).toBe(0n);
        });
      }
    }
  );
});

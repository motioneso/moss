import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type ManagedSourceKey } from "@moss/db";
import { MeetingRecordsRepository } from "@moss/meetings";
import { MemoryGraphRepository } from "@moss/memory";
import {
  ManagedSourceLifecycle,
  ManagedSourceUnavailableError
} from "../../packages/notes/src/managed-source-lifecycle.js";
import { RecordingFactMutations } from "../../packages/memory/src/recording-fact-mutations.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
const fixtureRunner = new DataContextRunner(appDb);
const owner = { actorUserId: ids.userA };
beforeAll(async () => {
  await resetFoundationDatabase();
});
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy()]);
});

describe("recording fact mutation admission", () => {
  it.each(["app", "worker"] as const)(
    "admits the full source union before graph mutations under %s",
    async (role) => {
      const runner = new DataContextRunner(role === "app" ? appDb : workerDb);
      const records = new MeetingRecordsRepository();
      const lifecycle = new ManagedSourceLifecycle(runner, {
        async assertExists(db, source) {
          if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId))) {
            throw new ManagedSourceUnavailableError();
          }
        }
      });
      const graph = new MemoryGraphRepository();
      const sources: ManagedSourceKey[] = [];
      for (let index = 0; index < 2; index++) {
        const result = await fixtureRunner.withDataContext(owner, (db) =>
          records.create(db, {
            requestKey: randomUUID(),
            title: "Synthetic fact admission source"
          })
        );
        const source = {
          ownerUserId: ids.userA,
          sourceModuleId: "meetings",
          sourceId: result.meeting.id
        };
        sources.push(source);
        await lifecycle.registerSource(owner, source);
      }
      const firstSource = sources[0]!;
      const secondSource = sources[1]!;
      const groupId = randomUUID();
      const factIds = await runner.withDataContext(owner, async (db) => {
        const self = await graph.ensureSelfEntity(db, ids.userA);
        await sql`INSERT INTO app.memory_conflict_groups(id,owner_user_id)
        VALUES (${groupId}::uuid,${ids.userA}::uuid)`.execute(db.db);
        const result: string[] = [];
        for (const source of sources) {
          const fact = await graph.createFact(db, ids.userA, {
            subjectEntityId: self.id,
            predicate: "works_on",
            objectText: "Synthetic admission text",
            source: {
              sourceKind: "manual",
              sourceRef: `manual:${randomUUID()}`,
              excerpt: "Synthetic admission text"
            }
          });
          await graph.deactivateSearchDocument(db, ids.userA, "fact", fact.id);
          await sql`INSERT INTO app.memory_recording_fact_versions(owner_user_id,fact_id,lineage_id,side)
          VALUES (${ids.userA}::uuid,${fact.id}::uuid,${fact.id}::uuid,'work')`.execute(db.db);
          await sql`UPDATE app.memory_facts SET recording_side = 'work',status = 'conflicting',conflict_group_id = ${groupId}::uuid
          WHERE owner_user_id = ${ids.userA}::uuid AND id = ${fact.id}::uuid`.execute(db.db);
          await sql`INSERT INTO app.memory_recording_receipts(owner_user_id,receipt_id,source_module_id,
          source_id,source_version,item_key,source_generation,side,state,fact_id,episode_id)
          VALUES (${ids.userA}::uuid,${randomBytes(32).toString("hex")},'meetings',${source.sourceId}::uuid,
            1,'admission',0,'work','undone',${fact.id}::uuid,${randomUUID()}::uuid)`.execute(db.db);
          result.push(fact.id);
        }
        return result;
      });
      const factId = factIds[0]!;
      let called = false;
      await expect(
        runner.withDataContext(owner, (db) =>
          new RecordingFactMutations().withFacts(db, ids.userA, [factId], async () => {
            called = true;
          })
        )
      ).rejects.toThrow("This recording's memory has changed");
      expect(called).toBe(false);
      const seen: string[] = [];
      const mutations = new RecordingFactMutations({
        registerSource: (access, source) => lifecycle.registerSource(access, source),
        captureSourcesScoped: (db, sources) => lifecycle.captureSourcesScoped(db, sources),
        async readCurrent() {
          return { sourceVersion: 1, side: "work" };
        },
        withReservation: (access, snapshot, work) =>
          lifecycle.withReservation(access, snapshot, work),
        withPublicationScoped: (db, snapshot, work) => {
          seen.push(...snapshot.sources.map((entry) => entry.source.sourceId));
          return lifecycle.withPublicationScoped(db, snapshot, work);
        }
      });
      await runner.withDataContext(owner, (db) =>
        mutations.withFacts(db, ids.userA, [factId], async () => {
          for (const id of factIds) mutations.assertLive(db, ids.userA, id);
          await sql`UPDATE app.memory_facts SET pinned = true WHERE owner_user_id = ${ids.userA}::uuid AND id = ${factId}::uuid`.execute(
            db.db
          );
        })
      );
      expect(new Set(seen)).toEqual(new Set([firstSource.sourceId, secondSource.sourceId]));
      await runner.withDataContext(owner, async (db) => {
        expect(() => mutations.assertLive(db, ids.userA, factId)).toThrow(
          "This recording's memory has changed"
        );
      });
      await lifecycle.fenceSource(owner, secondSource);
      called = false;
      await expect(
        runner.withDataContext(owner, (db) =>
          mutations.withFacts(db, ids.userA, [factId], async () => {
            called = true;
          })
        )
      ).rejects.toThrow("This recording has changed");
      expect(called).toBe(false);
    }
  );
});

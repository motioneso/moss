import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { MemoryGraphRepository } from "../../packages/memory/src/graph-repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;

beforeAll(async () => {
  await resetFoundationDatabase();

  appDb = createDatabase({
    connectionString: connectionStrings.app,
    maxConnections: 1
  });
  workerDb = createDatabase({
    connectionString: connectionStrings.worker,
    maxConnections: 1
  });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
});
afterAll(async () => {
  await appDb?.destroy();
  await workerDb?.destroy();
});

describe("Memory correction source identity", () => {
  it.each([
    { role: "app", conflict: false },
    { role: "worker", conflict: false },
    { role: "app", conflict: true },
    { role: "worker", conflict: true }
  ] as const)(
    "retains every original episode under $role (conflict: $conflict)",
    async ({ role, conflict }) => {
      const runner = role === "app" ? app : worker;
      const graph = new MemoryGraphRepository();
      await runner.withDataContext(
        {
          actorUserId: ids.userA,
          requestId: `memory-source-correction:${role}`
        },
        async (db) => {
          const self = await graph.ensureSelfEntity(db, ids.userA);
          const first = await graph.createEpisode(db, ids.userA, {
            sourceKind: "note",
            sourceRef: `note:${randomUUID()}`,
            sourceLabel: "First source",
            excerpt: "Original source excerpt"
          });
          const second = await graph.createEpisode(db, ids.userA, {
            sourceKind: "chat",
            sourceRef: `chat:${randomUUID()}`,
            sourceLabel: "Second source",
            excerpt: "Additional source excerpt"
          });
          const original = await graph.createFactFromEpisode(db, ids.userA, {
            subjectEntityId: self.id,
            predicate: "works_on",
            objectText: "Original wording",
            episodeId: first.id
          });
          await sql`
          INSERT INTO app.memory_fact_sources(owner_user_id, fact_id, episode_id)
          VALUES (${ids.userA}::uuid, ${original.id}::uuid, ${second.id}::uuid)
        `.execute(db.db);
          const expectedIds = [first.id, second.id];
          const expectedExcerpts = ["Original source excerpt", "Additional source excerpt"];
          let siblingId: string | undefined;
          if (conflict) {
            const third = await graph.createEpisode(db, ids.userA, {
              sourceKind: "note",
              sourceRef: `note:${randomUUID()}`,
              sourceLabel: "Conflict sibling source",
              excerpt: "Conflicting source excerpt"
            });
            const sibling = await graph.createFactFromEpisode(db, ids.userA, {
              subjectEntityId: self.id,
              predicate: "works_on",
              objectText: "Conflicting wording",
              episodeId: third.id
            });
            siblingId = sibling.id;
            const group = await sql<{ id: string }>`
              INSERT INTO app.memory_conflict_groups(owner_user_id)
              VALUES (${ids.userA}::uuid) RETURNING id
            `.execute(db.db);
            const groupId = group.rows[0]?.id;
            expect(groupId).toBeDefined();
            await sql`
              UPDATE app.memory_facts
              SET status = 'conflicting', conflict_group_id = ${groupId}::uuid
              WHERE owner_user_id = ${ids.userA}::uuid
                AND id IN (${original.id}::uuid, ${sibling.id}::uuid)
            `.execute(db.db);
            expectedIds.push(third.id);
            expectedExcerpts.push("Conflicting source excerpt");
          }
          const corrected = await graph.correctFact(db, ids.userA, {
            targetFactId: original.id,
            replacementText: "User corrected wording"
          });
          expect(corrected?.objectText).toBe("User corrected wording");
          expect(corrected?.sources.map((source) => source.id).sort()).toEqual(expectedIds.sort());
          expect(corrected?.sources.map((source) => source.excerpt).sort()).toEqual(
            expectedExcerpts.sort()
          );
          const documents = await graph.listSearchDocumentsForOwner(db, ids.userA);
          expect(documents.find((doc) => doc.targetId === original.id)?.status).toBe("inactive");
          expect(documents.find((doc) => doc.targetId === corrected?.id)).toMatchObject({
            status: "active",
            searchText: expect.stringContaining("User corrected wording")
          });
          if (siblingId) {
            expect(documents.find((doc) => doc.targetId === siblingId)?.status).toBe("inactive");
            const retired = await sql<{ status: string; superseded_by_fact_id: string }>`
              SELECT status, superseded_by_fact_id FROM app.memory_facts
              WHERE owner_user_id = ${ids.userA}::uuid AND id = ${siblingId}::uuid
            `.execute(db.db);
            expect(retired.rows[0]).toMatchObject({
              status: "superseded",
              superseded_by_fact_id: corrected?.id
            });
          }
          const episodes = await sql<{ id: string }>`
          SELECT id FROM app.memory_episodes
          WHERE owner_user_id = ${ids.userA}::uuid
            AND source_ref = ANY(${[first.sourceRef, second.sourceRef]}::text[])
        `.execute(db.db);
          expect(episodes.rows.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
        }
      );
    }
  );
});

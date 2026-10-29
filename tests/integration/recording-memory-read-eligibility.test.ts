import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";

import { StubEmbeddingProvider } from "@moss/memory";

import { MemoryGraphRepository } from "../../packages/memory/src/graph-repository.js";

import { ids } from "./test-database.js";

const { owner, setup } = useRecordingMemoryFixture();

describe("retired managed facts cannot reenter recall", () => {
  it.each(["app", "worker"] as const)(
    "filters a retired fact despite active derivative flags under %s",
    async (role) => {
      const { runner, service, graph, create } = await setup(role);
      const source = await create();
      const proposal = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Synthetic durable recording fact"
      });
      const receipt = (await service.apply(owner, { proposalId: proposal.id })).receipt;
      const episodeId = await runner.withDataContext(owner, async (db) => {
        const row = await sql<{
          episode_id: string;
        }>`SELECT episode_id FROM app.memory_recording_receipts
        WHERE owner_user_id = ${ids.userA}::uuid AND receipt_id = ${receipt.id}`.execute(db.db);
        return row.rows[0]!.episode_id;
      });
      const read = new MemoryGraphRepository();
      const embedding = await new StubEmbeddingProvider().embedQuery("Synthetic");
      const legacy = await runner.withDataContext(owner, async (db) => {
        const self = await graph.ensureSelfEntity(db, ids.userA);
        return graph.createFact(db, ids.userA, {
          subjectEntityId: self.id,
          predicate: "related_to",
          objectText: "Synthetic unrelated legacy fact",
          source: {
            sourceKind: "chat",
            sourceRef: randomUUID(),
            excerpt: "Synthetic unrelated legacy evidence"
          }
        });
      });
      const before = await runner.withDataContext(owner, (db) =>
        read.listFactRecallCandidates(db, ids.userA, embedding, {
          includeInactive: true,
          includeStale: true
        })
      );
      expect(before.map((candidate) => candidate.fact.id)).toContain(receipt.fact!.id);
      // Model a retirement/cascade which only updates durable lineage. Search flags are
      // deliberately left active: recall must consult current lineage independently.
      await runner.withDataContext(owner, (db) =>
        sql`UPDATE app.memory_facts SET status = 'superseded'
      WHERE owner_user_id = ${ids.userA}::uuid AND id = ${receipt.fact!.id}::uuid`.execute(db.db)
      );
      await runner.withDataContext(owner, async (db) => {
        const documents = await sql<{
          target_kind: string;
          status: string;
        }>`SELECT target_kind,status
        FROM app.memory_search_documents WHERE owner_user_id = ${ids.userA}::uuid
          AND ((target_kind = 'fact' AND target_id = ${receipt.fact!.id}::uuid)
            OR (target_kind = 'episode' AND target_id = ${episodeId}::uuid))`.execute(db.db);
        expect(documents.rows).toHaveLength(2);
        expect(documents.rows.every((document) => document.status === "active")).toBe(true);
        for (const options of [{}, { includeInactive: true, includeStale: true }]) {
          const candidates = await read.listFactRecallCandidates(db, ids.userA, embedding, options);
          expect(candidates.map((candidate) => candidate.fact.id)).not.toContain(receipt.fact!.id);
          expect(candidates.map((candidate) => candidate.fact.id)).toContain(legacy.id);
        }
        expect(
          (
            await sql<{ eligible: boolean }>`SELECT app.memory_recording_target_revision(
        ${ids.userA}::uuid,'episode',${episodeId}::uuid,'work') IS NOT NULL AS eligible`.execute(
              db.db
            )
          ).rows
        ).toEqual([{ eligible: false }]);
      });
    }
  );
});

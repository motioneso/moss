import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";

import { ids } from "./test-database.js";

const { owner, setup } = useRecordingMemoryFixture();

describe("managed episode provenance cannot become unlabelled", () => {
  it.each(["app", "worker"] as const)(
    "rejects an incomplete generic copy under %s",
    async (role) => {
      const { runner, service, graph, create } = await setup(role);
      const source = await create();
      const proposal = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Synthetic source owned fact"
      });
      const receipt = (await service.apply(owner, { proposalId: proposal.id })).receipt;
      const identity = await runner.withDataContext(owner, async (db) => {
        const result = await sql<{ episode_id: string; subject_entity_id: string }>`
        SELECT receipt.episode_id,fact.subject_entity_id FROM app.memory_recording_receipts receipt
        JOIN app.memory_facts fact ON fact.owner_user_id = receipt.owner_user_id AND fact.id = receipt.fact_id
        WHERE receipt.owner_user_id = ${ids.userA}::uuid AND receipt.receipt_id = ${receipt.id}`.execute(
          db.db
        );
        return result.rows[0]!;
      });
      // Correction may temporarily create an unlabelled replacement, but its final
      // transaction must transfer durable lineage before that new fact can commit.
      await expect(
        runner.withDataContext(owner, (db) =>
          graph.withFactMutation(db, ids.userA, [receipt.fact!.id], () =>
            graph.createFactFromEpisode(db, ids.userA, {
              subjectEntityId: identity.subject_entity_id,
              predicate: "related_to",
              objectText: "Synthetic attempted unlabelled copy",
              episodeId: identity.episode_id
            })
          )
        )
      ).rejects.toThrow("Recording provenance label is missing or incompatible");
      await runner.withDataContext(owner, async (db) => {
        const leaked =
          await sql`SELECT id FROM app.memory_facts WHERE owner_user_id = ${ids.userA}::uuid
        AND object_text = 'Synthetic attempted unlabelled copy'`.execute(db.db);
        expect(leaked.rows).toEqual([]);
      });
      const corrected = await runner.withDataContext(owner, (db) =>
        graph.correctFact(db, ids.userA, {
          targetFactId: receipt.fact!.id,
          replacementText: "Synthetic complete guarded correction"
        })
      );
      expect(corrected!.objectText).toBe("Synthetic complete guarded correction");
      expect((await service.inspect(owner, source))!.fact!.id).toBe(corrected!.id);
    }
  );
});

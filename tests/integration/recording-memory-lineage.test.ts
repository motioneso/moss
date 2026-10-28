import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";

import { ids } from "./test-database.js";

const { owner, setup } = useRecordingMemoryFixture();

describe("shared Memory source lineage", () => {
  it.each(["app", "worker"] as const)(
    "preserves all corrected associations and splits only the moving side under %s",
    async (role) => {
      const { runner, service, graph, create, flip } = await setup(role);
      const first = await create();
      const second = await create();
      const receipts = [];
      for (const source of [first, second]) {
        const proposal = await service.prepare(owner, {
          kind: "apply",
          requestId: randomUUID(),
          source,
          text: "Synthetic original shared text"
        });
        receipts.push((await service.apply(owner, { proposalId: proposal.id })).receipt);
      }
      const idsToJoin = receipts.map((r) => r.fact!.id);
      await runner.withDataContext(owner, (db) =>
        graph.withFactMutation(db, ids.userA, idsToJoin, async () => {
          const group = randomUUID();
          await sql`INSERT INTO app.memory_conflict_groups(id,owner_user_id) VALUES (${group}::uuid,${ids.userA}::uuid)`.execute(
            db.db
          );
          await sql`UPDATE app.memory_facts SET conflict_group_id = ${group}::uuid,status = 'conflicting'
        WHERE owner_user_id = ${ids.userA}::uuid AND id = ANY(${idsToJoin}::uuid[])`.execute(db.db);
        })
      );
      const text = "Synthetic owner correction with every association retained";
      const corrected = await runner.withDataContext(owner, (db) =>
        graph.correctFact(db, ids.userA, {
          targetFactId: idsToJoin[0]!,
          replacementText: text
        })
      );
      const before = (await service.inspect(owner, first))!;
      const other = (await service.inspect(owner, second))!;
      expect(before.fact!.id).toBe(corrected!.id);
      expect(other.fact!.id).toBe(corrected!.id);
      expect(corrected!.sources).toHaveLength(2);
      const undo = await service.prepare(owner, {
        kind: "undo",
        requestId: randomUUID(),
        receiptId: before.id,
        expectedRevision: before.revision,
        expectedFactRevision: before.fact!.revision
      });
      const undone = (await service.apply(owner, { proposalId: undo.id })).receipt;
      expect(undone.state).toBe("undone");
      expect((await service.inspect(owner, second))!.fact!.status).toBe("active");
      const restore = await service.prepare(owner, {
        kind: "restore",
        requestId: randomUUID(),
        receiptId: undone.id,
        expectedRevision: undone.revision,
        expectedFactRevision: undone.fact!.revision
      });
      const restored = (await service.apply(owner, { proposalId: restore.id })).receipt;
      await flip(first);
      const proposal = await service.prepare(owner, {
        kind: "reconcile_side",
        requestId: randomUUID(),
        receiptId: restored.id,
        expectedRevision: restored.revision,
        expectedFactRevision: restored.fact!.revision
      });
      const moved = (await service.apply(owner, { proposalId: proposal.id })).receipt;
      const stayed = (await service.inspect(owner, second))!;
      expect(moved).toMatchObject({
        side: "personal",
        state: "applied",
        fact: { text, corrected: true, status: "active" }
      });
      expect(stayed).toMatchObject({
        side: "work",
        state: "applied",
        fact: { id: corrected!.id, text, corrected: true, status: "active" }
      });
      expect(moved.fact!.id).not.toBe(stayed.fact!.id);
      expect((await service.apply(owner, { proposalId: proposal.id })).receipt.fact!.id).toBe(
        moved.fact!.id
      );
      await runner.withDataContext(owner, async (db) => {
        const associations = await sql<{
          side: string;
          count: number;
        }>`SELECT receipt.side,count(source.*)::int AS count
        FROM app.memory_recording_receipts receipt JOIN app.memory_fact_sources source
          ON source.owner_user_id = receipt.owner_user_id AND source.fact_id = receipt.fact_id
        WHERE receipt.owner_user_id = ${ids.userA}::uuid AND receipt.receipt_id = ANY(${[moved.id, stayed.id]}::text[])
        GROUP BY receipt.side ORDER BY receipt.side`.execute(db.db);
        expect(associations.rows).toEqual([
          { side: "personal", count: 1 },
          { side: "work", count: 1 }
        ]);
        const old =
          await sql`SELECT id FROM app.memory_search_documents WHERE owner_user_id = ${ids.userA}::uuid
        AND target_kind = 'fact' AND target_id = ANY(${idsToJoin}::uuid[]) AND status = 'active'`.execute(
            db.db
          );
        expect(old.rows).toEqual([]);
      });
    }
  );

  it.each(["app", "worker"] as const)(
    "rejects a late embedding after an identical-text source transition under %s",
    async (role) => {
      const { service, provider, create, lifecycle } = await setup(role);
      const source = await create();
      const proposal = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Synthetic late embedding"
      });
      let started!: () => void;
      let release!: () => void;
      const embeddingStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const releaseEmbedding = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = provider.embedDocument.bind(provider);
      provider.embedDocument = async (text: string) => {
        started();
        await releaseEmbedding;
        return original(text);
      };
      const applied = service.apply(owner, { proposalId: proposal.id });
      const rejected = expect(applied).rejects.toThrow("has changed");
      await embeddingStarted;
      try {
        const snapshot = await lifecycle.registerSource(owner, {
          ownerUserId: ids.userA,
          sourceModuleId: "meetings",
          sourceId: source.sourceId
        });
        // Identical side, version and text: only the source generation invalidates publication.
        await lifecycle.advanceSource(owner, snapshot, async () => {});
      } finally {
        release();
      }
      await rejected;
      expect((await service.inspect(owner, source))!.fact).toBeNull();
    }
  );
  it.each(["app", "worker"] as const)(
    "can undo an older output without restoring stale content under %s",
    async (role) => {
      const { service, create, flip } = await setup(role);
      const source = await create();
      const proposed = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Synthetic older output fact"
      });
      const receipt = (await service.apply(owner, { proposalId: proposed.id })).receipt;
      await flip(source, 2);
      const undo = await service.prepare(owner, {
        kind: "undo",
        requestId: randomUUID(),
        receiptId: receipt.id,
        expectedRevision: receipt.revision,
        expectedFactRevision: receipt.fact!.revision
      });
      const undone = (await service.apply(owner, { proposalId: undo.id })).receipt;
      expect(undone.state).toBe("undone");
      expect(undone.side).toBe("work");
      expect(undone.fact!.status).toBe("inactive");
      await expect(
        service.prepare(owner, {
          kind: "restore",
          requestId: randomUUID(),
          receiptId: undone.id,
          expectedRevision: undone.revision,
          expectedFactRevision: undone.fact!.revision
        })
      ).rejects.toThrow("has changed");
    }
  );
});

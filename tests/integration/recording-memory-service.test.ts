import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";

import { MemoryGraphRepository } from "../../packages/memory/src/graph-repository.js";

import { ids } from "./test-database.js";

const { owner, metadata, setup } = useRecordingMemoryFixture();

describe("reviewed recording Memory operations", () => {
  it.each(["app", "worker"] as const)(
    "keeps revisions, exact edits, undo/restore and source flips under %s",
    async (role) => {
      const { runner, lifecycle, service, graph, create } = await setup(role);
      const source = { ...(await create()), itemKey: "first" };
      const created = source.sourceId;
      const key = { ownerUserId: ids.userA, sourceModuleId: "meetings", sourceId: created };
      const proposed = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Synthetic exact original idea"
      });
      expect(proposed.before).toBeNull();
      const first = await service.apply(owner, { proposalId: proposed.id });
      expect(first.status).toBe("applied");
      expect(first.receipt).toMatchObject({
        side: "work",
        state: "applied",
        fact: { text: "Synthetic exact original idea" }
      });
      expect((await service.apply(owner, { proposalId: proposed.id })).status).toBe("unchanged");
      const change = await service.prepare(owner, {
        kind: "change",
        requestId: randomUUID(),
        receiptId: first.receipt.id,
        expectedRevision: first.receipt.revision,
        expectedFactRevision: first.receipt.fact!.revision,
        text: "Synthetic owner correction retained byte-exactly"
      });
      expect(change.before?.text).toBe("Synthetic exact original idea");
      const changed = await service.apply(owner, { proposalId: change.id });
      expect(changed.receipt.fact).toMatchObject({
        text: "Synthetic owner correction retained byte-exactly",
        corrected: true
      });
      await runner.withDataContext(owner, async (db) => {
        const old = await sql<{ status: string }>`SELECT status FROM app.memory_facts
        WHERE owner_user_id = ${ids.userA}::uuid AND id = ${first.receipt.fact!.id}::uuid`.execute(
          db.db
        );
        expect(old.rows[0]?.status).toBe("superseded");
      });
      const undo = await service.prepare(owner, {
        kind: "undo",
        requestId: randomUUID(),
        receiptId: changed.receipt.id,
        expectedRevision: changed.receipt.revision,
        expectedFactRevision: changed.receipt.fact!.revision
      });
      const undone = await service.apply(owner, { proposalId: undo.id });
      expect(undone.receipt).toMatchObject({ state: "undone", fact: { status: "inactive" } });
      const replay = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Attempted old replay"
      });
      expect((await service.apply(owner, { proposalId: replay.id })).status).toBe("unchanged");
      const restore = await service.prepare(owner, {
        kind: "restore",
        requestId: randomUUID(),
        receiptId: undone.receipt.id,
        expectedRevision: undone.receipt.revision,
        expectedFactRevision: undone.receipt.fact!.revision
      });
      const restored = await service.apply(owner, { proposalId: restore.id });
      expect(restored.receipt.fact?.text).toBe("Synthetic owner correction retained byte-exactly");
      const snapshot = await lifecycle.registerSource(owner, key);
      await lifecycle.advanceSource(owner, snapshot, async (db) => {
        const before = await metadata.get(db, created);
        await metadata.apply(
          db,
          before!,
          {
            title: "Synthetic source memory",
            typeId: "idea",
            side: "personal",
            confidence: 1,
            reason: "Synthetic personal fixture",
            ideaGroups: []
          },
          1
        );
      });
      const flip = await service.prepare(owner, {
        kind: "reconcile_side",
        requestId: randomUUID(),
        receiptId: restored.receipt.id,
        expectedRevision: restored.receipt.revision,
        expectedFactRevision: restored.receipt.fact!.revision
      });
      const flipped = await service.apply(owner, { proposalId: flip.id });
      expect(flipped.receipt).toMatchObject({
        side: "personal",
        fact: {
          id: restored.receipt.fact!.id,
          text: "Synthetic owner correction retained byte-exactly",
          corrected: true
        }
      });
      await expect(
        service.prepare(owner, {
          kind: "undo",
          requestId: randomUUID(),
          receiptId: flipped.receipt.id,
          expectedRevision: restored.receipt.revision,
          expectedFactRevision: restored.receipt.fact!.revision
        })
      ).rejects.toThrow("has changed");
      // A generic owner correction must move the source receipt to the surviving fact.
      const corrected = await runner.withDataContext(owner, (db) =>
        graph.correctFact(db, ids.userA, {
          targetFactId: flipped.receipt.fact!.id,
          replacementText: "Synthetic generic correction survives source moves"
        })
      );
      expect(corrected?.objectText).toBe("Synthetic generic correction survives source moves");
      const afterCorrection = (await service.inspect(owner, source))!;
      expect(afterCorrection.fact?.id).toBe(corrected!.id);
      expect(afterCorrection.fact?.corrected).toBe(true);
      expect(afterCorrection.fact?.id).not.toBe(flipped.receipt.fact!.id);
      await expect(
        runner.withDataContext(owner, (db) =>
          new MemoryGraphRepository().pinFact(db, ids.userA, afterCorrection.fact!.id, true)
        )
      ).rejects.toThrow("This recording's memory has changed");
      const pinned = await runner.withDataContext(owner, (db) =>
        graph.pinFact(db, ids.userA, afterCorrection.fact!.id, true)
      );
      expect(pinned).toBe(true);
      const afterPin = (await service.inspect(owner, source))!;
      expect(afterPin.fact!.revision).not.toBe(afterCorrection.fact!.revision);
      await expect(
        service.prepare(owner, {
          kind: "undo",
          requestId: randomUUID(),
          receiptId: afterPin.id,
          expectedRevision: afterCorrection.revision,
          expectedFactRevision: afterCorrection.fact!.revision
        })
      ).rejects.toThrow("has changed");
      await runner.withDataContext(owner, async (db) => {
        const documents = await sql<{
          recording_side: string;
        }>`SELECT recording_side FROM app.memory_search_documents
        WHERE owner_user_id = ${ids.userA}::uuid AND status = 'active' AND (
          (target_kind = 'fact' AND target_id = ${afterPin.fact!.id}::uuid) OR (target_kind = 'episode' AND target_id IN (
            SELECT episode_id FROM app.memory_recording_receipts WHERE owner_user_id = ${ids.userA}::uuid
              AND receipt_id = ${flipped.receipt.id})))`.execute(db.db);
        expect(documents.rows).toEqual([
          { recording_side: "personal" },
          { recording_side: "personal" }
        ]);
      });
    }
  );
});

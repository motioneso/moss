import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";

import { ids } from "./test-database.js";

const { setup } = useRecordingMemoryFixture();

describe("late recording Memory publishers respect deletion fences", () => {
  it.each([
    ["app", "source", ids.userA],
    ["worker", "source", ids.userB],
    ["app", "actor", ids.userC],
    ["worker", "actor", ids.userD]
  ] as const)(
    "rejects a delayed embedding after %s/%s fencing",
    async (role, boundary, actorUserId) => {
      const { owner, runner, lifecycle, provider, service, create } = await setup(
        role,
        actorUserId
      );
      const source = await create();
      const text = "Synthetic delayed publication after deletion fence";
      const proposal = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text
      });
      let started!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const embed = provider.embedDocument.bind(provider);
      provider.embedDocument = async (value: string) => {
        started();
        await held;
        return embed(value);
      };
      const applying = service.apply(owner, { proposalId: proposal.id });
      const rejected = expect(applying).rejects.toThrow("has changed or is being removed");
      await ready;
      try {
        if (boundary === "actor") await lifecycle.fenceActor(owner);
        else
          await lifecycle.fenceSource(owner, {
            ownerUserId: actorUserId,
            sourceModuleId: "meetings",
            sourceId: source.sourceId
          });
      } finally {
        release();
      }
      await rejected;
      expect((await service.inspect(owner, source))!.fact).toBeNull();
      await runner.withDataContext(owner, async (db) => {
        const facts = await sql`SELECT id FROM app.memory_facts
          WHERE owner_user_id = ${actorUserId}::uuid AND object_text = ${text}`.execute(db.db);
        expect(facts.rows).toEqual([]);
        const documents = await sql`SELECT id FROM app.memory_search_documents
          WHERE owner_user_id = ${actorUserId}::uuid AND search_text = ${text}`.execute(db.db);
        expect(documents.rows).toEqual([]);
      });
    }
  );
});

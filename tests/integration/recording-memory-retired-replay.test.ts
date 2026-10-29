import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";

import { ids } from "./test-database.js";

const { owner, setup } = useRecordingMemoryFixture();

describe("replayed proposals report durable retirement", () => {
  it.each(["app", "worker"] as const)(
    "returns forgotten after retirement without rewriting receipt history under %s",
    async (role) => {
      const { runner, service, create } = await setup(role);
      const source = await create();
      const proposal = await service.prepare(owner, {
        kind: "apply",
        requestId: randomUUID(),
        source,
        text: "Synthetic recording fact later retired"
      });
      const receipt = (await service.apply(owner, { proposalId: proposal.id })).receipt;
      await runner.withDataContext(owner, (db) =>
        sql`UPDATE app.memory_facts SET status = 'superseded'
      WHERE owner_user_id = ${ids.userA}::uuid AND id = ${receipt.fact!.id}::uuid`.execute(db.db)
      );
      expect(await service.apply(owner, { proposalId: proposal.id })).toMatchObject({
        status: "forgotten",
        receipt: { state: "forgotten" }
      });
    }
  );
});

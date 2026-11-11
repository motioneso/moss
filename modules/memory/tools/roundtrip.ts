/** Reads and writes graph rows with the old TypeScript repository, so the Rust database tests can
 *  prove rows written by one side read correctly on the other. Run only by the Rust db tests.
 *    roundtrip.ts write <actorUserId>          prints {factId, entityId}
 *    roundtrip.ts read <actorUserId> <factId>  prints what the old recall and core code returned */
import { DataContextRunner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { MemoryGraphRepository } from "../../../packages/memory/src/graph-repository.js";

const [mode, actor, factId] = process.argv.slice(2);
if (process.env.JARVIS_GATE_RUN !== "1" || !actor) throw new Error("Use the Rust db tests");

/** The same unit vector the Rust tests use, so similarity is exactly 1. */
const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 2 });
const runner = new DataContextRunner(db as never);
const repo = new MemoryGraphRepository();
const as = { actorUserId: actor, requestId: crypto.randomUUID() };

try {
  if (mode === "write") {
    const out = await runner.withDataContext(as, async (scoped) => {
      const self = await repo.ensureSelfEntity(scoped, actor);
      const fact = await repo.createFact(scoped, actor, {
        subjectEntityId: self.id,
        predicate: "prefers",
        objectText: "written by the old code",
        recordKind: "preference",
        confidence: 0.9,
        provenance: "volunteered",
        importance: 0.7,
        pinned: true,
        source: { sourceKind: "chat", sourceRef: "ts-thread", excerpt: "ts said so" }
      });
      await repo.upsertSearchDocument(
        scoped, actor, "fact", fact.id, "Self prefers written by the old code", vector, "stand-in", "1"
      );
      return { factId: fact.id, entityId: self.id };
    });
    console.log(JSON.stringify(out));
  } else if (mode === "read") {
    const out = await runner.withDataContext(as, async (scoped) => {
      const found = await repo.listFactRecallCandidates(scoped, actor, vector, {});
      const core = await repo.listCoreFacts(scoped, actor, 20);
      const hit = found.find((c) => c.fact.id === factId);
      return {
        recalled: Boolean(hit),
        similarity: hit?.vectorSimilarity ?? null,
        objectText: hit?.fact.objectText ?? null,
        sourceCount: hit?.fact.sources.length ?? 0,
        inCore: core.some((f) => f.id === factId)
      };
    });
    console.log(JSON.stringify(out));
  } else {
    throw new Error("mode must be write or read");
  }
} finally {
  await db.destroy();
}

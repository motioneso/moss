/** Reads and writes recording memory with the old TypeScript service, so the Rust recording tests
 *  can prove rows written by one side read correctly on the other. Run only by those tests.
 *    recording-roundtrip.ts meeting <actor>            makes a meeting; prints {sourceId}
 *    recording-roundtrip.ts write <actor> <text>       applies a fact; prints {sourceId}
 *    recording-roundtrip.ts read <actor> <sourceId>    prints {receipt, exported} as the old code sees them */
import { randomUUID } from "node:crypto";
import { DataContextRunner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { MeetingRecordsRepository, RecordingMetadataRepository } from "@moss/meetings";
import {
  RecordingMemoryService,
  StubEmbeddingProvider,
  collectRecordingMemoryExport
} from "@moss/memory";
import { createRecordingFactAuthority } from "@moss/module-registry";

const [mode, actor, extra] = process.argv.slice(2);
if (process.env.JARVIS_GATE_RUN !== "1" || !actor) throw new Error("Use the Rust recording tests");

const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 2 });
const runner = new DataContextRunner(db as never);
const owner = { actorUserId: actor };
const source = (sourceId: string) => ({
  sourceModuleId: "meetings" as const,
  sourceId,
  sourceVersion: 1,
  itemKey: "shared"
});

async function meeting(): Promise<string> {
  const records = new MeetingRecordsRepository();
  const metadata = new RecordingMetadataRepository();
  return runner.withDataContext(owner, async (scoped) => {
    const made = await records.create(scoped, {
      requestKey: randomUUID(),
      title: "Synthetic source"
    });
    const initial = await metadata.ensure(scoped, made.meeting.id);
    await metadata.apply(
      scoped,
      initial,
      {
        title: "Synthetic source",
        typeId: "idea",
        side: "work",
        confidence: 1,
        reason: "Synthetic work fixture",
        ideaGroups: []
      },
      1
    );
    return made.meeting.id;
  });
}

try {
  const service = new RecordingMemoryService(
    runner,
    createRecordingFactAuthority(runner),
    new StubEmbeddingProvider()
  );
  if (mode === "meeting") {
    console.log(JSON.stringify({ sourceId: await meeting() }));
  } else if (mode === "write") {
    const sourceId = await meeting();
    const proposal = await service.prepare(owner, {
      kind: "apply",
      requestId: randomUUID(),
      source: source(sourceId),
      text: extra ?? "written by the old code"
    });
    await service.apply(owner, { proposalId: proposal.id });
    console.log(JSON.stringify({ sourceId }));
  } else if (mode === "read") {
    const receipt = await service.inspect(owner, source(extra!));
    const exported = await runner.withDataContext(owner, (scoped) =>
      collectRecordingMemoryExport(scoped, actor)
    );
    console.log(JSON.stringify({ receipt, exported }));
  } else {
    throw new Error("mode must be meeting, write or read");
  }
} finally {
  await db.destroy();
}

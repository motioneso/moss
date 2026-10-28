import { randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { createDatabase, DataContextRunner } from "@moss/db";
import { MeetingRecordsRepository, RecordingMetadataRepository } from "@moss/meetings";
import { MemoryGraphRepository, RecordingMemoryService, StubEmbeddingProvider } from "@moss/memory";
import { ManagedSourceLifecycle, ManagedSourceUnavailableError } from "@moss/notes";
import { createRecordingFactAuthority } from "@moss/module-registry";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/** Each suite owns single-connection app/worker pools and exercises production host authority. */
export function useRecordingMemoryFixture() {
  const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  const workerDb = createDatabase({
    connectionString: connectionStrings.worker,
    maxConnections: 1
  });
  const fixtures = new DataContextRunner(appDb);
  const owner = { actorUserId: ids.userA };
  const records = new MeetingRecordsRepository();
  const metadata = new RecordingMetadataRepository();
  beforeAll(resetFoundationDatabase);
  afterAll(async () => {
    await Promise.all([appDb.destroy(), workerDb.destroy()]);
  });

  async function setup(role: "app" | "worker", actorUserId: string = ids.userA) {
    const owner = { actorUserId };
    const runner = new DataContextRunner(role === "app" ? appDb : workerDb);
    const lifecycle = new ManagedSourceLifecycle(runner, {
      async assertExists(db, source) {
        if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId))) {
          throw new ManagedSourceUnavailableError();
        }
      }
    });
    const authority = createRecordingFactAuthority(runner);
    const provider = new StubEmbeddingProvider();
    const service = new RecordingMemoryService(runner, authority, provider);
    const graph = new MemoryGraphRepository(authority);
    async function create() {
      const id = await fixtures.withDataContext(owner, async (db) => {
        const result = await records.create(db, {
          requestKey: randomUUID(),
          title: "Synthetic source"
        });
        const initial = await metadata.ensure(db, result.meeting.id);
        await metadata.apply(
          db,
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
        return result.meeting.id;
      });
      return {
        sourceModuleId: "meetings" as const,
        sourceId: id,
        sourceVersion: 1,
        itemKey: "shared"
      };
    }
    async function flip(source: { sourceId: string }, version = 1) {
      const snapshot = await lifecycle.registerSource(owner, {
        ownerUserId: actorUserId,
        sourceModuleId: "meetings",
        sourceId: source.sourceId
      });
      await lifecycle.advanceSource(owner, snapshot, async (db) => {
        const initial = await metadata.get(db, source.sourceId);
        await metadata.apply(
          db,
          initial!,
          {
            title: "Synthetic source",
            typeId: "idea",
            side: "personal",
            confidence: 1,
            reason: "Synthetic personal fixture",
            ideaGroups: []
          },
          version
        );
      });
    }
    return { owner, runner, lifecycle, provider, service, graph, create, flip };
  }
  return { appDb, workerDb, fixtures, owner, records, metadata, setup };
}

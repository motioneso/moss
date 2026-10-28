import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, DataContextRunner, type DataContextDb } from "@moss/db";
import { createPgBossClient, sendJob } from "@moss/jobs";
import { MeetingRecordsRepository } from "@moss/meetings";
import {
  MemoryRepository,
  parseDocument,
  registerVaultIngestWorkers,
  StubEmbeddingProvider,
  VAULT_INGEST_NUDGE_QUEUE,
  VAULT_INGEST_SWEEP_QUEUE
} from "@moss/memory";
import { createManagedNoteSnapshotPort } from "@moss/module-registry";
import {
  ManagedSourceLifecycle,
  ManagedSourceUnavailableError,
  NOTES_SYNC_QUEUE,
  RecordingContributionService,
  registerNotesJobWorkers
} from "@moss/notes";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import type { RecordingNoteSource } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";
import { VaultContextRunner } from "@moss/vault";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerVaultIngestRootProvider,
  resetVaultIngestRootProvidersForTests
} from "../../packages/memory/src/vault-ingest-registry.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
const runner = new DataContextRunner(appDb);
const worker = new DataContextRunner(workerDb);
const records = new MeetingRecordsRepository();
const owner = { actorUserId: ids.userA };
const repository = new MemoryRepository();
const preferences = new PreferencesRepository();
const authority = {
  async assertExists(db: DataContextDb, source: { sourceModuleId: string; sourceId: string }) {
    if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId)))
      throw new ManagedSourceUnavailableError();
  },
  async readCurrent(db: DataContextDb, source: RecordingNoteSource) {
    await this.assertExists(db, source);
    return { sourceVersion: 1, side: "work" as const };
  }
};
let workspace: string;
let root: string;
let privateBase: string;
let vault: VaultContextRunner;
let service: RecordingContributionService;

beforeAll(resetFoundationDatabase);
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "moss-managed-worker-"));
  root = join(workspace, "linked");
  privateBase = join(workspace, "private");
  await mkdir(root);
  vi.stubEnv("MOSS_NOTES_ROOTS", root);
  vi.stubEnv("JARVIS_NOTES_ROOTS", root);
  await runner.withDataContext(owner, (db) =>
    preferences.upsert(db, NOTES_SOURCE_PREFERENCE_KEY, root)
  );
  vault = new VaultContextRunner(privateBase);
  service = new RecordingContributionService({
    runner,
    lifecycle: new ManagedSourceLifecycle(runner, authority),
    authority,
    privateVault: vault,
    index: {
      async invalidateScoped(db, ids) {
        await repository.invalidateManagedDestinations(db, owner.actorUserId, ids);
      },
      async enqueueScoped() {}
    }
  });
  resetVaultIngestRootProvidersForTests();
  registerVaultIngestRootProvider({
    moduleId: "managed-worker-fixture",
    resolveRoots: async () => ["notes"]
  });
});
afterEach(async () => {
  resetVaultIngestRootProvidersForTests();
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy()]);
});

async function contribution(linked: boolean) {
  const { meeting } = await runner.withDataContext(owner, (db) =>
    records.create(db, { requestKey: randomUUID(), title: "Synthetic worker source" })
  );
  const source: RecordingNoteSource = {
    sourceModuleId: "meetings",
    sourceId: meeting.id,
    sourceVersion: 1,
    itemKey: "topic"
  };
  const candidate = linked
    ? (await service.inventory(owner)).candidates.find((item) => item.displayPath === "topic.md")!
    : null;
  const review = await service.prepare(owner, {
    kind: "apply",
    requestId: randomUUID(),
    source,
    text: "Managed worker contribution",
    destination: candidate
      ? { kind: "candidate", candidateId: candidate.id, candidateRevision: candidate.revision }
      : { kind: "fallback" }
  });
  return (await service.apply(owner, { proposalId: review.id, acceptBinding: true })).receipt;
}

async function indexSnapshot(sourceKind: string, sourcePath: string) {
  return runner.withDataContext(
    owner,
    async (db) =>
      (
        await sql<{ count: number; snapshot: { side: string; destinationId: string } }>`
    select chunk_count as count, managed_snapshot as snapshot from app.memory_file_index
    where source_kind=${sourceKind} and source_path=${sourcePath}
  `.execute(db.db)
      ).rows[0] ?? null
  );
}

describe("registered workers with owning managed publication", () => {
  it("enqueues and completes labelled oversized-note continuations through the actual Notes worker", async () => {
    await writeFile(join(root, "topic.md"), "x".repeat(210000));
    const receipt = await contribution(true);
    const expected = parseDocument(await readFile(join(root, "topic.md"), "utf8")).chunks.length;
    expect(expected).toBeGreaterThan(100);
    const boss = createPgBossClient(connectionStrings.worker);
    await boss.start();
    try {
      await registerNotesJobWorkers(boss, worker, {
        preferencesRepository: preferences,
        embeddingProviderFactory: async () => new StubEmbeddingProvider(),
        publication: createManagedNoteSnapshotPort(worker)
      });
      await sendJob(boss, NOTES_SYNC_QUEUE, { actorUserId: owner.actorUserId, sourcePath: root });
      await expect
        .poll(async () => (await indexSnapshot("notes", join(root, "topic.md")))?.count, {
          timeout: 20000
        })
        .toBe(expected);
      expect((await indexSnapshot("notes", join(root, "topic.md")))?.snapshot).toMatchObject({
        side: "work",
        destinationId: receipt.destination.id
      });
      const count = await runner.withDataContext(
        owner,
        async (db) =>
          (
            await sql<{
              count: number;
            }>`select count(*)::int as count from app.memory_chunks where source_path=${join(root, "topic.md")}`.execute(
              db.db
            )
          ).rows[0]!.count
      );
      expect(count).toBe(expected);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it.each(["sweep", "nudge"] as const)(
    "runs the registered private %s with one connection and persists source labels",
    async (kind) => {
      const receipt = await contribution(false);
      const path = receipt.destination.displayPath;
      const boss = createPgBossClient(connectionStrings.worker);
      await boss.start();
      try {
        await registerVaultIngestWorkers(boss, worker, {
          vaultRunner: vault,
          vaultsBaseDir: privateBase,
          embeddingProviderFactory: async () => new StubEmbeddingProvider(),
          publication: createManagedNoteSnapshotPort(worker)
        });
        await sendJob(
          boss,
          kind === "sweep" ? VAULT_INGEST_SWEEP_QUEUE : VAULT_INGEST_NUDGE_QUEUE,
          {
            actorUserId: owner.actorUserId,
            ...(kind === "nudge" ? { sourcePath: path, op: "upsert" } : {})
          }
        );
        await expect.poll(() => indexSnapshot("vault", path), { timeout: 15000 }).not.toBeNull();
        expect((await indexSnapshot("vault", path))?.snapshot).toMatchObject({
          side: "work",
          destinationId: receipt.destination.id
        });
      } finally {
        await boss.stop({ graceful: false });
      }
    }
  );
});

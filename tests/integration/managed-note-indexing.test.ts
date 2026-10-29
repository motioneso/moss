import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, DataContextRunner, type DataContextDb } from "@moss/db";
import { MeetingRecordsRepository } from "@moss/meetings";
import { StubEmbeddingProvider } from "@moss/memory";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";
import { readVaultFile, VaultContextRunner, type VaultContext } from "@moss/vault";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { RecordingContributionService } from "../../packages/notes/src/recording-contributions.js";
import {
  ManagedSourceLifecycle,
  ManagedSourceUnavailableError
} from "../../packages/notes/src/managed-source-lifecycle.js";
import { ManagedNoteSnapshotService } from "../../packages/notes/src/managed-note-snapshots.js";
import { MemoryRepository } from "../../packages/memory/src/repository.js";
import { ingestVaultDocument } from "../../packages/memory/src/ingest-document.js";
import { MemoryIngestPipeline } from "../../packages/memory/src/ingest.js";
import type { RecordingNoteSource } from "@moss/shared";
import type { RecordingNoteReceipt } from "@moss/shared";

const appDb = createDatabase({ connectionString: connectionStrings.app });
const runner = new DataContextRunner(appDb);
const records = new MeetingRecordsRepository();
const repository = new MemoryRepository();
const owner = { actorUserId: ids.userA };
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
const lifecycle = new ManagedSourceLifecycle(runner, authority);
let workspace: string;
let root: string;
let vault: VaultContextRunner;
let service: RecordingContributionService;
let publication: ManagedNoteSnapshotService;
let receipt: RecordingNoteReceipt;

async function recording(): Promise<RecordingNoteSource> {
  const { meeting } = await runner.withDataContext(owner, (db) =>
    records.create(db, { requestKey: randomUUID(), title: "Synthetic managed index source" })
  );
  return { sourceModuleId: "meetings", sourceId: meeting.id, sourceVersion: 1, itemKey: "topic" };
}
function context<T>(work: (ctx: VaultContext) => Promise<T>): Promise<T> {
  return receipt.destination.kind === "private"
    ? vault.withVaultContext(owner, work)
    : vault.withVaultContextAt(owner, root, [root], work);
}
async function derivatives() {
  return runner.withDataContext(owner, async (db) => ({
    chunks: (
      await sql<{
        snapshot: unknown;
      }>`select managed_snapshot as snapshot from app.memory_chunks where managed_snapshot->>'destinationId'=${receipt.destination.id}`.execute(
        db.db
      )
    ).rows,
    index: (
      await sql<{
        snapshot: unknown;
      }>`select managed_snapshot as snapshot from app.memory_file_index where managed_snapshot->>'destinationId'=${receipt.destination.id}`.execute(
        db.db
      )
    ).rows
  }));
}
async function applySource(source: RecordingNoteSource, text: string, linked = false) {
  const candidate = linked
    ? (await service.inventory(owner)).candidates.find((entry) => entry.displayPath === "topic.md")!
    : null;
  const review = await service.prepare(owner, {
    kind: "apply",
    requestId: randomUUID(),
    source,
    text,
    destination: candidate
      ? { kind: "candidate", candidateId: candidate.id, candidateRevision: candidate.revision }
      : { kind: "fallback" }
  });
  return (await service.apply(owner, { proposalId: review.id, acceptBinding: true })).receipt;
}

beforeAll(async () => {
  await resetFoundationDatabase();
});
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "moss-managed-index-"));
  root = join(workspace, "linked");
  await mkdir(root);
  await writeFile(join(root, "topic.md"), "");
  vi.stubEnv("MOSS_NOTES_ROOTS", root);
  vi.stubEnv("JARVIS_NOTES_ROOTS", root);
  await runner.withDataContext(owner, (db) =>
    new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, root)
  );
  vault = new VaultContextRunner(join(workspace, "private"));
  publication = new ManagedNoteSnapshotService(lifecycle);
  service = new RecordingContributionService({
    runner,
    lifecycle,
    authority,
    privateVault: vault,
    index: {
      async invalidateScoped(db, destinationIds) {
        await repository.invalidateManagedDestinations(db, owner.actorUserId, destinationIds);
      },
      async enqueueScoped() {}
    }
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});
afterAll(async () => {
  await Promise.all([appDb.destroy()]);
});

describe("managed note index publication", () => {
  it("publishes a managed BOM-prefixed note without changing its original bytes", async () => {
    await writeFile(join(root, "topic.md"), "\uFEFFOriginal note\n");
    receipt = await applySource(await recording(), "Managed contribution", true);
    const before = await readFile(join(root, "topic.md"));
    expect(before.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    await context((ctx) =>
      runner.withDataContext(owner, (db) =>
        ingestVaultDocument(
          db,
          ctx,
          "topic.md",
          { sourceKind: "notes", sourcePath: join(root, "topic.md") },
          { repository, embeddingProvider: new StubEmbeddingProvider(), publication }
        )
      )
    );
    expect((await derivatives()).index).toHaveLength(1);
    expect(await readFile(join(root, "topic.md"))).toEqual(before);
  });

  it.each(["private", "linked"] as const)(
    "rejects a paused %s embedding after source deletion admission",
    async (kind) => {
      const source = await recording();
      receipt = await applySource(source, "Retained source text", kind === "linked");
      let release!: () => void;
      let entered!: () => void;
      const embedded = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      class PausedProvider extends StubEmbeddingProvider {
        override async embedDocument(text: string) {
          entered();
          await resume;
          return super.embedDocument(text);
        }
      }
      const provider = new PausedProvider();
      const work = context((ctx) =>
        runner.withDataContext(owner, async (db) =>
          kind === "private"
            ? new MemoryIngestPipeline(provider, repository, publication).ingestFile(
                db,
                ctx,
                receipt.destination.displayPath
              )
            : ingestVaultDocument(
                db,
                ctx,
                "topic.md",
                { sourceKind: "notes", sourcePath: join(root, "topic.md") },
                { repository, embeddingProvider: provider, publication }
              )
        )
      );
      await embedded;
      try {
        await lifecycle.fenceSource(owner, {
          ownerUserId: owner.actorUserId,
          sourceModuleId: "meetings",
          sourceId: source.sourceId
        });
      } finally {
        release();
      }
      expect((await work).status).toBe("skipped");
      expect(await derivatives()).toEqual({ chunks: [], index: [] });
    }
  );

  it("restarts a partial checkpoint when unchanged bytes acquire a newer binding revision", async () => {
    const source = await recording();
    receipt = await applySource(source, "A".repeat(7000), true);
    const ingest = (checkpoint?: { chunkOffset: number; fileHash: string; snapshotKey?: string }) =>
      context((ctx) =>
        runner.withDataContext(owner, (db) =>
          ingestVaultDocument(
            db,
            ctx,
            "topic.md",
            {
              sourceKind: "notes",
              sourcePath: join(root, "topic.md"),
              chunkLimit: 1,
              ...(checkpoint
                ? {
                    chunkOffset: checkpoint.chunkOffset,
                    expectedFileHash: checkpoint.fileHash,
                    expectedSnapshotKey: checkpoint.snapshotKey
                  }
                : {})
            },
            { repository, embeddingProvider: new StubEmbeddingProvider(), publication }
          )
        )
      );
    const first = await ingest();
    expect(first.continuation?.chunkOffset).toBe(1);
    await runner.withDataContext(owner, async (db) => {
      await sql`update app.notes_destination_bindings set revision=revision+1 where destination_id=${receipt.destination.id}`.execute(
        db.db
      );
      await repository.invalidateManagedDestinations(db, owner.actorUserId, [
        receipt.destination.id
      ]);
    });
    const next = await ingest(first.continuation);
    expect(next.continuation?.chunkOffset).toBe(1);
    expect(next.continuation?.snapshotKey).not.toBe(first.continuation?.snapshotKey);
    expect((await derivatives()).chunks).toHaveLength(1);
    expect((await derivatives()).index).toHaveLength(0);
  });

  it("invalidates capture when another recording joins the destination during embedding", async () => {
    receipt = await applySource(await recording(), "First source", true);
    const expected = await context((ctx) =>
      runner.withDataContext(owner, async (db) =>
        publication.captureScoped(db, ctx, "topic.md", await readVaultFile(ctx, "topic.md"))
      )
    );
    expect(expected.status).toBe("ready");
    await applySource(await recording(), "Second source", true);
    let called = false;
    const result = await context((ctx) =>
      runner.withDataContext(owner, (db) => {
        if (expected.status !== "ready") throw new Error("Expected capture");
        return publication.publishScoped(db, ctx, "topic.md", expected.snapshot, async () => {
          called = true;
        });
      })
    );
    expect(result.status).toBe("stale");
    expect(called).toBe(false);
  });

  it("retains a side-bound snapshot after the last source block is undone", async () => {
    receipt = await applySource(await recording(), "Temporary source", true);
    await writeFile(
      join(root, "topic.md"),
      `${await readFile(join(root, "topic.md"), "utf8")}\nOwner text remains\n`
    );
    await service.undo(owner, {
      requestId: randomUUID(),
      receiptId: receipt.id,
      expectedRevision: receipt.revision
    });
    const result = await context((ctx) =>
      runner.withDataContext(owner, (db) =>
        ingestVaultDocument(
          db,
          ctx,
          "topic.md",
          { sourceKind: "notes", sourcePath: join(root, "topic.md") },
          { repository, embeddingProvider: new StubEmbeddingProvider(), publication }
        )
      )
    );
    expect(result.status).toBe("ingested");
    const stored = await derivatives();
    expect(stored.index).toHaveLength(1);
    expect(stored.index[0]?.snapshot).toMatchObject({ side: "work", sources: [] });
  });

  it("does not replace an empty bound index with an unlabelled legacy publication", async () => {
    receipt = await applySource(await recording(), "Temporary source", true);
    await service.undo(owner, {
      requestId: randomUUID(),
      receiptId: receipt.id,
      expectedRevision: receipt.revision
    });
    const ingest = (guarded: boolean) =>
      context((ctx) =>
        runner.withDataContext(owner, (db) =>
          ingestVaultDocument(
            db,
            ctx,
            "topic.md",
            { sourceKind: "notes", sourcePath: join(root, "topic.md"), force: true },
            {
              repository,
              embeddingProvider: new StubEmbeddingProvider(),
              ...(guarded ? { publication } : {})
            }
          )
        )
      );
    expect((await ingest(true)).status).toBe("ingested");
    expect((await derivatives()).chunks).toHaveLength(0);
    await expect(ingest(false)).rejects.toThrow(
      "Managed derivatives require current snapshot publication authority"
    );
    expect((await derivatives()).index[0]?.snapshot).toMatchObject({ side: "work" });
  });

  it("serializes duplicate partial publishers and resumes without duplicate chunks", async () => {
    receipt = await applySource(await recording(), "A".repeat(7000), true);
    let release!: () => void;
    let entered!: () => void;
    let calls = 0;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    class RacingProvider extends StubEmbeddingProvider {
      override async embedDocument(text: string) {
        if (++calls === 2) entered();
        await resume;
        return super.embedDocument(text);
      }
    }
    const provider = new RacingProvider();
    const ingest = () =>
      context((ctx) =>
        runner.withDataContext(owner, (db) =>
          ingestVaultDocument(
            db,
            ctx,
            "topic.md",
            { sourceKind: "notes", sourcePath: join(root, "topic.md"), chunkLimit: 1 },
            { repository, embeddingProvider: provider, publication }
          )
        )
      );
    const first = ingest();
    const second = ingest();
    await paused;
    release();
    const results = await Promise.all([first, second]);
    expect(results.reduce((count, result) => count + result.chunksProcessed, 0)).toBe(1);
    expect((await derivatives()).chunks).toHaveLength(1);
    let complete = false;
    for (let page = 0; page < 10; page++) {
      const result = await ingest();
      if (!result.continuation) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    const stored = await derivatives();
    expect(stored.index).toHaveLength(1);
    const indexCount = await runner.withDataContext(
      owner,
      async (db) =>
        (
          await sql<{
            count: number;
          }>`select chunk_count as count from app.memory_file_index where source_path=${join(root, "topic.md")}`.execute(
            db.db
          )
        ).rows[0]!.count
    );
    expect(stored.chunks).toHaveLength(indexCount);
  });
});

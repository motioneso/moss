import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
import type { NotesSyncJobPayload } from "../../packages/notes/src/jobs.js";

const state = vi.hoisted(() => ({ allowedRoot: "" }));
const parsedChunks = Array.from({ length: 250 }, (_, index) => ({
  text: `chunk-${index}`,
  lineStart: index,
  lineEnd: index
}));
const embedCalls: number[] = [];
const upsertCalls: Array<{ count: number; replaceExisting: boolean }> = [];

vi.mock("@moss/settings", () => ({
  NOTES_LAST_SYNC_PREFERENCE_KEY: "notes-last-sync",
  NOTES_SOURCE_PREFERENCE_KEY: "notes-source-path",
  RuntimeConfigResolver: class {},
  resolveNotesRoots: () => [state.allowedRoot]
}));

vi.mock("@moss/memory", () => ({
  CpuIsolatedEmbeddingProvider: class {},
  createEmbeddingProvider: vi.fn(),
  embedChunks: vi.fn(async (_provider: unknown, chunks: readonly { text: string }[]) => {
    embedCalls.push(chunks.length);
    return chunks.map((chunk) => ({
      ...chunk,
      sourcePath: "note.md",
      contentHash: chunk.text,
      embedding: [1]
    }));
  }),
  getEmbeddingProviderConfig: vi.fn(),
  MemoryRepository: class {
    async getFileIndex() {
      return null;
    }

    async upsertFileChunks(...args: readonly unknown[]) {
      const chunks = args[3] as readonly unknown[];
      const replaceExisting = args[7] as boolean | undefined;
      upsertCalls.push({ count: chunks.length, replaceExisting: replaceExisting ?? false });
    }

    async replaceFileLinks() {}
    async upsertFileIndex() {}
  },
  parseDocument: vi.fn(() => ({ chunks: parsedChunks, wikilinks: [] }))
}));

describe("notes.sync chunk cap (#1590)", () => {
  let root = "";

  afterEach(async () => {
    state.allowedRoot = "";
    embedCalls.length = 0;
    upsertCalls.length = 0;
  });

  it("continues a large file without dropping chunks", async () => {
    root = await mkdtemp(join(tmpdir(), "notes-sync-cap-"));
    state.allowedRoot = root;
    await writeFile(join(root, "note.md"), "large note");

    const { handleNotesSyncJobWithDataContext, NOTES_SYNC_MAX_CHUNKS_PER_RUN } =
      await import("../../packages/notes/src/jobs.js");
    const provider = {
      dimensions: 1,
      modelName: "test",
      modelVersion: "1",
      embedDocument: vi.fn(),
      embedQuery: vi.fn()
    };
    const preferences = { get: vi.fn(async () => root) } as never;
    const dataContext = {
      withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) => work({})
    } as never;
    const job = (data = {}) =>
      ({
        id: "job",
        data: { actorUserId: "00000000-0000-4000-8000-000000000001", sourcePath: root, ...data }
      }) as Job<NotesSyncJobPayload>;

    const first = await handleNotesSyncJobWithDataContext(
      job(),
      dataContext,
      async () => provider,
      preferences
    );
    const second = await handleNotesSyncJobWithDataContext(
      job(first.continuation),
      dataContext,
      async () => provider,
      preferences
    );
    const third = await handleNotesSyncJobWithDataContext(
      job(second.continuation),
      dataContext,
      async () => provider,
      preferences
    );

    expect(NOTES_SYNC_MAX_CHUNKS_PER_RUN).toBe(100);
    expect(embedCalls).toEqual([100, 100, 50]);
    expect(upsertCalls).toEqual([
      { count: 100, replaceExisting: true },
      { count: 100, replaceExisting: false },
      { count: 50, replaceExisting: false }
    ]);
    expect(first.deferred).toBe(true);
    expect(second.deferred).toBe(true);
    expect(third).toEqual({ ingested: 1, skipped: 0, errors: 0 });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";

const mockEmbed = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => vi.fn());

vi.mock("@moss/settings", () => ({
  RuntimeConfigResolver: vi.fn()
}));

vi.mock("@moss/memory", () => ({
  getEmbeddingProviderConfig: vi.fn().mockResolvedValue({ kind: "stub", modelId: "test" }),
  createEmbeddingProvider: vi.fn().mockReturnValue({}),
  MemoryRepository: vi.fn(),
  MemoryRetriever: vi.fn().mockImplementation(function MemoryRetriever(this: {
    embedQuery: typeof mockEmbed;
    searchByEmbedding: typeof mockSearch;
  }) {
    this.embedQuery = mockEmbed;
    this.searchByEmbedding = mockSearch;
  })
}));

const { createNotesRecallPort } = await import("../../packages/notes/src/recall.js");

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;
const dataContext = {
  withDataContext: async (_ctx: unknown, cb: (db: DataContextDb) => unknown) => cb(scopedDb)
} as never;
const EMBEDDING = [0.1, 0.2];

describe("createNotesRecallPort", () => {
  beforeEach(() => {
    mockEmbed.mockReset().mockResolvedValue(EMBEDDING);
    mockSearch.mockReset();
  });

  it("maps RetrievedChunk fields to NotesRecallSnippet", async () => {
    const updatedAt = new Date("2026-08-01T00:00:00.000Z");
    mockSearch.mockResolvedValue([
      {
        id: "chunk-1",
        sourcePath: "notes/todo.md",
        lineStart: 1,
        lineEnd: 3,
        text: "buy milk",
        similarity: 0.87,
        updatedAt
      }
    ]);

    const port = createNotesRecallPort();
    const result = await port.recall(dataContext, "user-1", "milk", {});

    expect(result.snippets).toEqual([
      { sourcePath: "notes/todo.md", updatedAt, score: 0.87, text: "buy milk" }
    ]);
    expect(mockSearch).toHaveBeenCalledWith(scopedDb, EMBEDDING, 8, "notes");
  });

  it("defaults to DEFAULT_LIMIT (8) when no limit is given", async () => {
    mockSearch.mockResolvedValue([]);

    const port = createNotesRecallPort();
    await port.recall(dataContext, "user-1", "q", {});

    expect(mockSearch).toHaveBeenCalledWith(scopedDb, EMBEDDING, 8, "notes");
  });

  it("clamps a limit above MAX_LIMIT (20) down to 20", async () => {
    mockSearch.mockResolvedValue([]);

    const port = createNotesRecallPort();
    await port.recall(dataContext, "user-1", "q", { limit: 500 });

    expect(mockSearch).toHaveBeenCalledWith(scopedDb, EMBEDDING, 20, "notes");
  });

  it("clamps a limit below 1 up to 1", async () => {
    mockSearch.mockResolvedValue([]);

    const port = createNotesRecallPort();
    await port.recall(dataContext, "user-1", "q", { limit: 0 });

    expect(mockSearch).toHaveBeenCalledWith(scopedDb, EMBEDDING, 1, "notes");
  });
});

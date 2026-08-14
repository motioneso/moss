import { describe, expect, it, vi } from "vitest";

import type { DataContextRunner } from "@moss/db";

import { NotesContextRetriever } from "../../packages/chat/src/live/notes-retrieval.js";

const BASE_INPUT = {
  actorUserId: "u1",
  userText: "what did we decide about the house project?",
  threadTitle: null,
  recentTurns: [],
  incognito: false
} as const;

function settingsRepo(recallEnabled = true) {
  return {
    getOrCreate: async () => ({
      userId: "u1",
      recallEnabled,
      factsEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  };
}

const dataContext: Pick<DataContextRunner, "withDataContext"> = {
  withDataContext: async (_ctx, cb) => cb({} as never)
};

describe("NotesContextRetriever", () => {
  it("skips the port entirely when incognito", async () => {
    const notesRecall = { recall: vi.fn() };
    const retriever = new NotesContextRetriever({
      dataContext,
      notesRecall,
      settingsRepo: settingsRepo(true)
    });

    const result = await retriever.retrieveWithItems({ ...BASE_INPUT, incognito: true });

    expect(result).toEqual({ block: "", items: [] });
    expect(notesRecall.recall).not.toHaveBeenCalled();
  });

  it("skips the port entirely when recall is disabled", async () => {
    const notesRecall = { recall: vi.fn() };
    const retriever = new NotesContextRetriever({
      dataContext,
      notesRecall,
      settingsRepo: settingsRepo(false)
    });

    const result = await retriever.retrieveWithItems(BASE_INPUT);

    expect(result).toEqual({ block: "", items: [] });
    expect(notesRecall.recall).not.toHaveBeenCalled();
  });

  it("returns an empty result when the port exceeds its own timeout", async () => {
    vi.useFakeTimers();
    try {
      const notesRecall = {
        recall: vi
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve({ snippets: [] }), 1000))
          )
      };
      const retriever = new NotesContextRetriever({
        dataContext,
        notesRecall,
        settingsRepo: settingsRepo(true)
      });

      const pending = retriever.retrieveWithItems(BASE_INPUT);
      await vi.advanceTimersByTimeAsync(501);

      await expect(pending).resolves.toEqual({ block: "", items: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty result when the port throws", async () => {
    const notesRecall = { recall: vi.fn().mockRejectedValue(new Error("boom")) };
    const retriever = new NotesContextRetriever({
      dataContext,
      notesRecall,
      settingsRepo: settingsRepo(true)
    });

    const result = await retriever.retrieveWithItems(BASE_INPUT);

    expect(result).toEqual({ block: "", items: [] });
  });

  it("caps at the top 5 snippets by score", async () => {
    const snippets = Array.from({ length: 8 }, (_, i) => ({
      sourcePath: `notes/${i}.md`,
      updatedAt: new Date("2026-06-01T00:00:00Z"),
      score: i / 10,
      text: `snippet body ${i}`
    }));
    const notesRecall = { recall: vi.fn().mockResolvedValue({ snippets }) };
    const retriever = new NotesContextRetriever({
      dataContext,
      notesRecall,
      settingsRepo: settingsRepo(true)
    });

    const result = await retriever.retrieveWithItems(BASE_INPUT);

    expect(result.items).toHaveLength(5);
    expect(result.items.map((item) => item.sourcePath)).toEqual([
      "notes/7.md",
      "notes/6.md",
      "notes/5.md",
      "notes/4.md",
      "notes/3.md"
    ]);
  });

  it("caps combined snippet text at 2000 tokens", async () => {
    const snippets = Array.from({ length: 3 }, (_, i) => ({
      sourcePath: `notes/${i}.md`,
      updatedAt: new Date("2026-06-01T00:00:00Z"),
      score: 1 - i / 10,
      text: "a".repeat(4000) // ~1000 tokens each — 3 would exceed the 2000 cap
    }));
    const notesRecall = { recall: vi.fn().mockResolvedValue({ snippets }) };
    const retriever = new NotesContextRetriever({
      dataContext,
      notesRecall,
      settingsRepo: settingsRepo(true)
    });

    const result = await retriever.retrieveWithItems(BASE_INPUT);

    expect(result.items.length).toBeLessThan(3);
    expect(result.items[0]?.sourcePath).toBe("notes/0.md");
  });

  it("drops credential-shaped snippets and still injects the remainder", async () => {
    const snippets = [
      {
        sourcePath: "notes/leak.md",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        score: 0.9,
        text: "Authorization: Bearer sk-abc123def456ghi789"
      },
      {
        sourcePath: "notes/safe.md",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
        score: 0.5,
        text: "kitchen remodel paint swatches picked"
      }
    ];
    const notesRecall = { recall: vi.fn().mockResolvedValue({ snippets }) };
    const retriever = new NotesContextRetriever({
      dataContext,
      notesRecall,
      settingsRepo: settingsRepo(true)
    });

    const result = await retriever.retrieveWithItems(BASE_INPUT);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sourcePath).toBe("notes/safe.md");
    expect(result.block).toContain("paint swatches");
    expect(result.block).not.toContain("Bearer");
  });
});

import { expect, it, vi } from "vitest";

import { buildEngineText } from "../../packages/chat/src/live/engine-text.js";

it("never injects page context into ordinary engine text (#1109 — pull-only tool replaces the turn push)", async () => {
  const result = await buildEngineText({ persistence: {} as never }, "u1", "hello");
  expect(result.text).toBe("hello");
  expect(result.text).not.toContain("<page_context>");
});

it("retrieves passive, cross-tool, and notes context in parallel", async () => {
  let resolvePassive!: (value: { block: string; items: [] }) => void;
  let resolveNotes!: (value: {
    block: string;
    items: Array<{ sourcePath: string; updatedAt: Date; score: number; text: string }>;
  }) => void;
  const passiveRetrieval = {
    retrieve: vi.fn(),
    retrieveWithItems: vi.fn(
      () => new Promise<{ block: string; items: [] }>((resolve) => (resolvePassive = resolve))
    )
  };
  const notesRetrieval = {
    retrieveWithItems: vi.fn(
      () =>
        new Promise<{
          block: string;
          items: Array<{ sourcePath: string; updatedAt: Date; score: number; text: string }>;
        }>((resolve) => (resolveNotes = resolve))
    )
  };
  const crossToolRead = {
    runReadTool: vi.fn(async (_actorUserId: string, toolName: string) =>
      toolName === "notes.search"
        ? {
            ok: true,
            data: {
              chunks: [
                {
                  sourcePath: "projects/remodel.md",
                  text: "Cross-tool remodel context",
                  lineStart: 1,
                  lineEnd: 2
                }
              ]
            }
          }
        : { ok: true, data: {} }
    )
  };

  const pending = buildEngineText(
    {
      persistence: {
        listPriorTurns: async () => ({ recent: [] }),
        getThreadContext: async () => ({
          threadTitle: "Remodel",
          localTimezone: "UTC",
          incognito: true
        })
      } as never,
      passiveRetrieval,
      crossToolRead,
      notesRetrieval
    },
    "u1",
    "what is the status of Remodel?"
  );

  await vi.waitFor(() => {
    expect(passiveRetrieval.retrieveWithItems).toHaveBeenCalledOnce();
    expect(notesRetrieval.retrieveWithItems).toHaveBeenCalledOnce();
    expect(crossToolRead.runReadTool).toHaveBeenCalled();
  });
  expect(notesRetrieval.retrieveWithItems).toHaveBeenCalledWith(
    expect.objectContaining({ actorUserId: "u1", incognito: true })
  );

  resolvePassive({ block: "<memory>Passive fact</memory>", items: [] });
  resolveNotes({
    block: "<retrieved_context>Notes context</retrieved_context>",
    items: [
      {
        sourcePath: "projects/remodel.md",
        updatedAt: new Date("2026-08-01T12:00:00Z"),
        score: 0.9,
        text: "Notes context"
      }
    ]
  });

  const result = await pending;
  expect(result.text).toContain("Passive fact");
  expect(result.text).toContain("Cross-tool remodel context");
  expect(result.text).toContain("Notes context");
  expect(result.pendingItems).toContainEqual(
    expect.objectContaining({
      sourceKind: "note",
      sourceLabel: "projects/remodel.md",
      occurredAt: "2026-08-01T12:00:00.000Z"
    })
  );
});

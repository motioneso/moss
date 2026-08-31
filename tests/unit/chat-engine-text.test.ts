import { expect, it, vi } from "vitest";

import type { DataContextRunner } from "@moss/db";

import { buildEngineText } from "../../packages/chat/src/live/engine-text.js";
import { renderCurrentTimeContext } from "../../packages/chat/src/live/time-context.js";
import { NotesContextRetriever } from "../../packages/chat/src/live/notes-retrieval.js";

const dataContext: Pick<DataContextRunner, "withDataContext"> = {
  withDataContext: async (_ctx, cb) => cb({} as never)
};

it("states the correct UTC and local weekdays at the Pacific date boundary (#1869)", () => {
  const context = renderCurrentTimeContext(
    new Date("2026-08-31T04:50:00.000Z"),
    "America/Los_Angeles"
  );

  expect(context).toContain("2026-08-31T04:50:00.000Z (Monday)");
  expect(context).toContain("2026-08-30 (Sunday) 21:50 (America/Los_Angeles");
});

it("lets the local date and weekday advance across midnight (#1869 review)", () => {
  const before = renderCurrentTimeContext(
    new Date("2026-08-31T06:59:00.000Z"),
    "America/Los_Angeles"
  );
  const after = renderCurrentTimeContext(
    new Date("2026-08-31T07:01:00.000Z"),
    "America/Los_Angeles"
  );

  expect(before).toContain("2026-08-30 (Sunday) 23:59");
  expect(after).toContain("2026-08-31 (Monday) 00:01");
  expect(after).toContain("let the date and weekday move forward");
  expect(after).not.toContain("never contradict an earlier turn");
});

it("keeps the repeated local time distinct across the daylight saving change (#1869 review)", () => {
  const before = renderCurrentTimeContext(
    new Date("2026-11-01T08:30:00.000Z"),
    "America/Los_Angeles"
  );
  const after = renderCurrentTimeContext(
    new Date("2026-11-01T09:30:00.000Z"),
    "America/Los_Angeles"
  );

  expect(before).toContain("2026-11-01 (Sunday) 01:30 (America/Los_Angeles, UTC offset -420");
  expect(after).toContain("2026-11-01 (Sunday) 01:30 (America/Los_Angeles, UTC offset -480");
});

it("tells the model to state a known local zone as fact and stay consistent (#1869)", () => {
  const context = renderCurrentTimeContext(
    new Date("2026-08-31T05:13:00.000Z"),
    "America/Los_Angeles"
  );

  expect(context).toContain("State that local date, weekday, time and time zone as fact.");
  expect(context).toContain("Do not hedge");
  expect(context).toContain("do not flip-flop about the known time zone");
  expect(context).not.toContain("local time zone is not known");
});

it("admits an unknown local zone once and forbids guessing it (#1869 run_6 follow-up)", () => {
  const context = renderCurrentTimeContext(new Date("2026-08-31T05:13:00.000Z"), null);

  expect(context).toContain("The user's local time zone is not known this turn.");
  expect(context).toContain("once, the first time you mention it");
  expect(context).toContain("Never guess the user's time zone, region or location");
  expect(context).toContain("do not show time zone arithmetic unless the user asks for it");
  expect(context).toContain("do not flip-flop about the known time zone");
  expect(context).not.toContain("User's local time:");
});

it("treats an unusable time zone the same as no time zone at all (#1869)", () => {
  const context = renderCurrentTimeContext(new Date("2026-08-31T05:13:00.000Z"), "Not/AZone");

  expect(context).toContain("The user's local time zone is not known this turn.");
  expect(context).not.toContain("User's local time:");
});

it("never injects page context into ordinary engine text (#1109 — pull-only tool replaces the turn push)", async () => {
  const now = new Date("2026-08-22T12:00:00.000Z");
  const result = await buildEngineText(
    {
      persistence: { getThreadContext: async () => ({ localTimezone: null }) } as never,
      now: () => now
    },
    "u1",
    "hello"
  );
  expect(result.text).toBe(`${renderCurrentTimeContext(now, null)}\n\nhello`);
  expect(result.text).not.toContain("<page_context>");
});

it("still carries the fresh time block when no retrieval deps exist at all (#1869 spec decision 5)", async () => {
  const now = new Date("2026-08-22T23:59:00.000Z");
  const result = await buildEngineText({ persistence: {} as never, now: () => now }, "u1", "hello");
  expect(result.text).toContain("<current_time_context>");
  expect(result.text).toContain(now.toISOString());
  expect(result.text.endsWith("\n\nhello")).toBe(true);
});

it("keeps the fresh UTC instant, but drops the local date, when getThreadContext rejects (#1869 spec decision 6)", async () => {
  const now = new Date("2026-08-22T23:59:00.000Z");
  const result = await buildEngineText(
    {
      persistence: {
        listPriorTurns: async () => ({ recent: [] }),
        getThreadContext: async () => {
          throw new Error("locale read failed");
        }
      } as never,
      crossToolRead: { runReadTool: vi.fn(async () => ({ ok: true, data: {} })) },
      now: () => now
    },
    "u1",
    "what time is it?"
  );
  expect(result.text).toContain(now.toISOString());
  expect(result.text).not.toContain("User's local time");
  expect(result.text).toContain("what time is it?");
});

it("keeps the fresh time block even when a retrieval dependency throws inside the shared try block", async () => {
  const now = new Date("2026-08-22T23:59:00.000Z");
  const result = await buildEngineText(
    {
      persistence: {
        listPriorTurns: async () =>
          new Promise((_, reject) => setTimeout(() => reject(new Error("boom")), 0)),
        getThreadContext: async () => ({
          threadTitle: null,
          localTimezone: "America/Los_Angeles",
          incognito: false
        })
      } as never,
      crossToolRead: { runReadTool: vi.fn(async () => ({ ok: true, data: {} })) },
      now: () => now
    },
    "u1",
    "what time is it?"
  );
  expect(result.text).toContain(now.toISOString());
  expect(result.text).toContain("America/Los_Angeles");
  expect(result.text).not.toContain("local time zone is not known");
  expect(result.text).toContain("what time is it?");
});

it("uses the guarded retriever as the sole automatic notes path", async () => {
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
          incognito: false
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
    expect.objectContaining({ actorUserId: "u1", incognito: false })
  );
  expect(crossToolRead.runReadTool.mock.calls.map((call) => call[1])).not.toContain("notes.search");

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
  expect(result.text).toContain("Notes context");
  expect(result.pendingItems).toContainEqual(
    expect.objectContaining({
      sourceKind: "note",
      sourceLabel: "projects/remodel.md",
      occurredAt: "2026-08-01T12:00:00.000Z"
    })
  );
});

it.each([
  ["incognito", true, true],
  ["recall disabled", false, false]
])("does not let cross-tool notes bypass %s", async (_label, incognito, recallEnabled) => {
  const notesRecall = { recall: vi.fn().mockResolvedValue({ snippets: [] }) };
  const notesRetrieval = new NotesContextRetriever({
    dataContext,
    notesRecall,
    settingsRepo: {
      getOrCreate: async () => ({
        userId: "u1",
        recallEnabled,
        factsEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }
  });
  const crossToolRead = {
    runReadTool: vi.fn(async (_actorUserId: string, toolName: string) => ({
      ok: true,
      data:
        toolName === "notes.search"
          ? {
              chunks: [
                {
                  sourcePath: "notes/project.md",
                  text: "cross-tool bypass marker",
                  lineStart: 1,
                  lineEnd: 1
                }
              ]
            }
          : {}
    }))
  };

  const result = await buildEngineText(
    {
      persistence: {
        listPriorTurns: async () => ({ recent: [] }),
        getThreadContext: async () => ({
          threadTitle: "Remodel",
          localTimezone: "UTC",
          incognito
        })
      } as never,
      crossToolRead,
      notesRetrieval
    },
    "u1",
    "what is the status of Remodel?"
  );

  expect(notesRecall.recall).not.toHaveBeenCalled();
  expect(crossToolRead.runReadTool.mock.calls.map((call) => call[1])).not.toContain("notes.search");
  expect(result.text).not.toContain("cross-tool bypass marker");
});

it("keeps automatic notes retrieval within the approved 500ms budget", async () => {
  vi.useFakeTimers();
  try {
    const notesRecall = {
      recall: vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ snippets: [] }), 1000))
        )
    };
    const notesRetrieval = new NotesContextRetriever({
      dataContext,
      notesRecall,
      settingsRepo: {
        getOrCreate: async () => ({
          userId: "u1",
          recallEnabled: true,
          factsEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date()
        })
      }
    });
    const now = new Date("2026-08-22T12:00:00.000Z");
    const pending = buildEngineText(
      {
        persistence: {
          listPriorTurns: async () => ({ recent: [] }),
          getThreadContext: async () => ({
            threadTitle: "Remodel",
            localTimezone: "UTC",
            incognito: false
          })
        } as never,
        crossToolRead: { runReadTool: vi.fn(async () => ({ ok: true, data: {} })) },
        notesRetrieval,
        now: () => now
      },
      "u1",
      "what is the status of Remodel?"
    );

    await vi.advanceTimersByTimeAsync(501);

    await expect(pending).resolves.toEqual({
      text: `${renderCurrentTimeContext(now, "UTC")}\n\nwhat is the status of Remodel?`,
      pendingItems: []
    });
  } finally {
    vi.useRealTimers();
  }
});

process.env.TZ = "UTC";

import { describe, expect, it, vi } from "vitest";

import { RecallService } from "@moss/chat";
import type { DataContextRunner } from "@moss/db";

import { NotesContextRetriever } from "../../packages/chat/src/live/notes-retrieval.js";
import { PassiveContextRetriever } from "../../packages/chat/src/live/passive-retrieval.js";

/**
 * #3395: dates handed to the AI for remembered chats, memories and notes fall on the person's own
 * day. The machine runs in UTC; 03:30 UTC on Oct 10 is 20:30 on Oct 9 in Los Angeles.
 */

const PACIFIC_24 = { timezone: "America/Los_Angeles", region: "en-GB", dateFormat: "24" };
const LATE_EVENING_PACIFIC = new Date("2026-10-10T03:30:00.000Z");

function localePreferences() {
  return {
    get: vi.fn(async (_db: unknown, key: string) => (key === "locale" ? PACIFIC_24 : null))
  };
}

const dataContext: Pick<DataContextRunner, "withDataContext"> = {
  withDataContext: async (_ctx, callback) => callback({} as never)
};

const settingsRepo = {
  getOrCreate: async () => ({
    userId: "u1",
    recallEnabled: true,
    factsEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date()
  })
};

const RECALL_INPUT = {
  actorUserId: "u1",
  userText: "what did we decide?",
  threadTitle: null,
  recentTurns: []
} as const;

type RecallServiceDeps = ConstructorParameters<typeof RecallService>;

describe("dates the AI reads for recalled context", () => {
  it("dates a remembered chat by the person's day", async () => {
    const prefs = localePreferences();
    const service = new RecallService(
      dataContext as RecallServiceDeps[0],
      { embedQuery: async () => [0.1, 0.2] } as unknown as RecallServiceDeps[1],
      {
        vectorSearch: async () => [
          {
            id: "c1",
            sourcePath: "thread-1",
            lineStart: 0,
            lineEnd: 1,
            text: "We picked the blue tiles.",
            similarity: 0.9,
            updatedAt: LATE_EVENING_PACIFIC
          }
        ]
      } as unknown as RecallServiceDeps[2],
      {} as RecallServiceDeps[3],
      {
        getOrCreate: async () => ({ recallEnabled: true, factsEnabled: false })
      } as unknown as RecallServiceDeps[4],
      {
        getThreadById: async () => ({
          last_active_at: LATE_EVENING_PACIFIC,
          updated_at: LATE_EVENING_PACIFIC
        })
      } as unknown as RecallServiceDeps[5],
      prefs
    );

    const result = await service.recall("u1");

    expect(result.episodicChunks.map((chunk) => chunk.date)).toEqual(["2026-10-09"]);
    expect(prefs.get).toHaveBeenCalledWith(expect.anything(), "locale");
  });

  it("dates a remembered fact by the person's day", async () => {
    const retriever = new PassiveContextRetriever({
      dataContext,
      settingsRepo,
      localePreferences: localePreferences(),
      graphRecall: {
        recall: async () => ({
          items: [
            {
              kind: "fact" as const,
              id: "f1",
              title: "prefers",
              text: "Blue tiles",
              score: 0.9,
              confidence: 0.8,
              confidenceTier: "high" as const,
              recordKind: "fact" as const,
              status: "stale" as const,
              provenance: "volunteered" as const,
              validFrom: null,
              validTo: null,
              staleAt: LATE_EVENING_PACIFIC,
              supersededByFactId: null,
              conflictGroupId: null,
              sources: []
            }
          ]
        })
      } as never
    });

    const block = await retriever.retrieve(RECALL_INPUT);

    expect(block).toContain("stale_at=2026-10-09");
  });

  it("dates a recalled note by the person's day", async () => {
    const retriever = new NotesContextRetriever({
      dataContext,
      settingsRepo,
      localePreferences: localePreferences(),
      notesRecall: {
        recall: async () => ({
          snippets: [
            {
              sourcePath: "notes/kitchen.md",
              updatedAt: LATE_EVENING_PACIFIC,
              score: 0.9,
              text: "paint swatches picked"
            }
          ]
        })
      } as never
    });

    const { block } = await retriever.retrieveWithItems({ ...RECALL_INPUT, incognito: false });

    expect(block).toContain("[notes/kitchen.md modified=2026-10-09]");
  });
});

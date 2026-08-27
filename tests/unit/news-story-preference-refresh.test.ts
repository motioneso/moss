import { describe, expect, it } from "vitest";

import type { PgBoss } from "pg-boss";

import { buildStoryPreferenceRefresh } from "../../packages/module-registry/src/index.js";

/**
 * #2018. Saving a "less like this" on a news story has to change what the news page shows, and
 * the only thing that recomputes the page is a refresh. This is the composition root's decision:
 * which module hears about a preference change, and what it does about it.
 */
describe("story preference refresh (#2018)", () => {
  function fakeQueue(): PgBoss & { sent: { queue: string; payload: unknown }[] } {
    const sent: { queue: string; payload: unknown }[] = [];
    return {
      sent,
      send: async (queue: string, payload: unknown) => {
        sent.push({ queue, payload });
        return "job-1";
      }
    } as unknown as PgBoss & { sent: { queue: string; payload: unknown }[] };
  }

  it("asks News to recompile after a news story preference changes", async () => {
    const queue = fakeQueue();
    await buildStoryPreferenceRefresh(queue)({
      ownerUserId: "00000000-0000-0000-0000-00000000000a",
      targetKind: "news_story"
    });
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.queue).toContain("news");
  });

  it("does nothing for a sports story, which is a separate piece of work", async () => {
    const queue = fakeQueue();
    await buildStoryPreferenceRefresh(queue)({
      ownerUserId: "00000000-0000-0000-0000-00000000000a",
      targetKind: "sports_story"
    });
    expect(queue.sent).toEqual([]);
  });

  it("carries only who owns the work, never the reason the owner typed", async () => {
    const queue = fakeQueue();
    await buildStoryPreferenceRefresh(queue)({
      ownerUserId: "00000000-0000-0000-0000-00000000000a",
      targetKind: "news_story"
    });
    expect(JSON.stringify(queue.sent)).toContain("00000000-0000-0000-0000-00000000000a");
    expect(JSON.stringify(queue.sent)).not.toMatch(/reason|headline|http/i);
  });

  it("is a no-op, not a failure, in a setup running without a queue", async () => {
    await expect(
      buildStoryPreferenceRefresh(null)({
        ownerUserId: "00000000-0000-0000-0000-00000000000a",
        targetKind: "news_story"
      })
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  registerBacktrackWorkers,
  BACKTRACK_UPKEEP_CRON
} from "../../packages/backtrack/src/jobs.js";
import { assertMetadataOnlyPayload } from "@moss/jobs";

describe("registerBacktrackWorkers", () => {
  it("works the index queue and schedules the hourly upkeep at minute 7", async () => {
    const work = vi.fn(async () => "work-id");
    const schedule = vi.fn(async () => undefined);
    const boss = { work, schedule } as never;

    const ids = await registerBacktrackWorkers(boss, {
      dataContext: {} as never,
      rootDb: {} as never,
      embeddingProviderFactory: async () => {
        throw new Error("not called");
      }
    });

    expect(ids).toEqual(["work-id", "work-id"]);
    expect(work.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "backtrack.index",
      "backtrack.upkeep"
    ]);
    expect(BACKTRACK_UPKEEP_CRON).toBe("7 * * * *");
    expect(schedule).toHaveBeenCalledTimes(1);
    const [queue, cron, payload] = schedule.mock.calls[0] as unknown as [string, string, unknown];
    expect([queue, cron]).toEqual(["backtrack.upkeep", "7 * * * *"]);
    expect(() => assertMetadataOnlyPayload(payload)).not.toThrow();
  });

  it("accepts the index payload shape and refuses content-bearing keys beside it", () => {
    const ids = ["00000000-0000-4000-8000-000000000001"];
    expect(() => assertMetadataOnlyPayload({ actorUserId: ids[0], segmentIds: ids })).not.toThrow();
    expect(() =>
      assertMetadataOnlyPayload({ actorUserId: ids[0], segmentIds: ids, body: "text" })
    ).toThrow();
  });
});

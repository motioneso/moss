import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";
import { FOCUS_JUDGMENT_PURGE_QUEUE } from "@moss/jobs";

import { registerFocusJudgmentPurgeWorker } from "./jobs.js";

describe("registerFocusJudgmentPurgeWorker", () => {
  it("schedules a nightly purge whose payload carries only the job kind", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const work = vi.fn().mockResolvedValue("work-id");
    const workerDb = {} as Kysely<MossDatabase>;
    const purgeExpired = vi.fn().mockResolvedValue(4);

    const id = await registerFocusJudgmentPurgeWorker({ schedule, work } as never, workerDb, {
      purgeExpired
    });

    expect(id).toBe("work-id");
    expect(schedule).toHaveBeenCalledWith(
      FOCUS_JUDGMENT_PURGE_QUEUE,
      "15 3 * * *",
      { kind: "focus-judgment-purge" },
      { tz: "UTC", key: FOCUS_JUDGMENT_PURGE_QUEUE }
    );

    const handler = work.mock.calls[0]?.[1] as () => Promise<unknown>;
    await expect(handler()).resolves.toEqual({ purgedRows: 4 });
    expect(purgeExpired).toHaveBeenCalledWith(workerDb);
  });
});

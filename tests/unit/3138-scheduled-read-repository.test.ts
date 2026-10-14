import { describe, expect, it } from "vitest";
import { recordScheduledObservation } from "../../packages/chat/src/scheduled-reads/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

describe("recurring scheduled-read observation persistence", () => {
  it.each(["failed", "refused"] as const)(
    "%s clamps the integer before addition so the maximum streak cannot overflow",
    async (outcome) => {
      const { scoped, queries } = makeRecordingDb();
      await recordScheduledObservation(scoped, "check-id", outcome, null);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).toContain('"failure_streak" = least(failure_streak, 2147483646) + 1');
      expect(queries[0]!.parameters).toEqual([outcome, "check-id"]);
    }
  );
  it("valid success replaces the observation and resets the saturated streak", async () => {
    const { scoped, queries } = makeRecordingDb();
    const observation = "a".repeat(64);
    await recordScheduledObservation(scoped, "check-id", "success", observation);
    expect(queries[0]!.sql).toContain('"failure_streak" = $3');
    expect(queries[0]!.parameters).toEqual(["success", observation, 0, "check-id"]);
  });
});

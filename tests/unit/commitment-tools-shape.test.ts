import { describe, it, expect } from "vitest";
import type { ToolContext } from "@moss/module-sdk";
import {
  commitmentListExecute,
  commitmentGetExecute,
  commitmentAcceptExecute,
  commitmentRejectExecute,
  commitmentSnoozeExecute,
  commitmentThreadJudgementsExecute
} from "@moss/commitments/tools";
import { makeRecordingDb } from "./helpers/recording-db.js";

const ctx: ToolContext = {
  actorUserId: "user-1",
  requestId: "req-1",
  chatSessionId: "session-1"
};

describe("commitment tools", () => {
  it.each(["item", "no_item", undefined])(
    "exposes the recorded thread outcome %s without defaulting",
    async (outcome) => {
      const { scoped, queries } = makeRecordingDb({
        rows: [{ thread_ref: "t1", judged_at: new Date("2026-10-11T12:00:00Z"), outcome }]
      });
      const result = await commitmentThreadJudgementsExecute(scoped, { threadRefs: ["t1"] }, ctx);
      expect(result.data).toEqual({
        threads: [{ threadRef: "t1", judgedAt: "2026-10-11T12:00:00.000Z", outcome }]
      });
      expect(queries[0]?.parameters).toEqual([ctx.actorUserId, "t1"]);
    }
  );
  it("exports all 5 execute functions", () => {
    expect(typeof commitmentListExecute).toBe("function");
    expect(typeof commitmentGetExecute).toBe("function");
    expect(typeof commitmentAcceptExecute).toBe("function");
    expect(typeof commitmentRejectExecute).toBe("function");
    expect(typeof commitmentSnoozeExecute).toBe("function");
  });

  it("rejects an unbranded db context at the boundary before repository work", async () => {
    const unbranded = {};
    await expect(commitmentListExecute(unbranded, {}, ctx)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(commitmentGetExecute(unbranded, { candidateId: "c1" }, ctx)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(commitmentAcceptExecute(unbranded, { candidateId: "c1" }, ctx)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(commitmentRejectExecute(unbranded, { candidateId: "c1" }, ctx)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(
      commitmentSnoozeExecute(
        unbranded,
        { candidateId: "c1", snoozedUntil: "2026-01-01T00:00:00.000Z" },
        ctx
      )
    ).rejects.toThrow("Repository access requires withDataContext");
  });
});

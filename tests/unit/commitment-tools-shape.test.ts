import { describe, it, expect } from "vitest";
import type { ToolContext } from "@moss/module-sdk";
import {
  commitmentListExecute,
  commitmentGetExecute,
  commitmentAcceptExecute,
  commitmentRejectExecute,
  commitmentSnoozeExecute
} from "@moss/commitments/tools";

const ctx: ToolContext = {
  actorUserId: "user-1",
  requestId: "req-1",
  chatSessionId: "session-1"
};

describe("commitment tools", () => {
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

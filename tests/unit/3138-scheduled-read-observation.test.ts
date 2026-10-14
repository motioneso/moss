import { describe, expect, it } from "vitest";
import {
  scheduledObservationKey,
  scheduledObservationDecision,
  recurringReadFailureMessage,
  scheduledFailureNotification
} from "../../packages/chat/src/scheduled-reads/observation.js";

const task = { id: "owned", title: "Proof", status: "todo" };
describe("bounded recurring Tasks observations", () => {
  it("first valid observation establishes a quiet baseline", () => {
    expect(scheduledObservationDecision(null, task)).toBe("baseline");
  });
  it("same exact semantic observation stays quiet", () => {
    expect(scheduledObservationDecision(scheduledObservationKey(task), task)).toBe("unchanged");
    const withTimestamp = { ...task, updatedAt: "later" };
    expect(scheduledObservationKey(withTimestamp)).toBe(scheduledObservationKey(task));
  });
  it.each([{ title: "Revised" }, { status: "done" }, { id: "other" }])(
    "a changed task identity/title/status is new information",
    (change) => {
      expect(
        scheduledObservationDecision(scheduledObservationKey(task), { ...task, ...change })
      ).toBe("changed");
    }
  );
  it("observation storage contains no private source prose", () => {
    const key = scheduledObservationKey(task);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain(task.title);
  });
  it("terminal failure guidance never claims continuing work or an available Pause control", () => {
    const message = recurringReadFailureMessage("failed", false);
    expect(message).toContain("now complete");
    expect(message).not.toContain("keep checking");
    expect(message).not.toContain("pause");
    expect(recurringReadFailureMessage("refused", true)).toContain("saved cadence");
  });
  it("only the third exhausted consecutive run posts failure guidance", () => {
    expect([0, 1, 2, 3, 4, 100].map(scheduledFailureNotification)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { scheduledReminder } from "../../packages/chat/src/reminders/settings.js";
const row = {
  id: "check",
  reminder_text: "Check task status: Proof",
  state: "queued" as const,
  thread_id: "main",
  due_at: new Date("2026-10-13T09:00:00Z"),
  deadline_at: null,
  created_at: new Date("2026-10-13T08:00:00Z"),
  delivered_at: null,
  expired_at: null,
  late: null,
  message_id: null,
  message_body: null,
  repeat_kind: "interval" as const,
  repeat_seconds: 60,
  local_due: null,
  time_zone: null
};
describe("recurring check execution status is independent of lifecycle", () => {
  it.each(["queued", "paused"] as const)(
    "failed %s check preserves controls and explains recovery",
    (state) => {
      const result = scheduledReminder({ ...row, state, read_outcome: "failed" });
      expect(result.state).toBe(state === "queued" ? "active" : "paused");
      expect(result.checkFailure).toContain("saved cadence");
      expect(result.schedule).toBe("Every 1 minute");
    }
  );
  it("valid quiet success clears guidance", () => {
    expect(scheduledReminder({ ...row, read_outcome: "success" }).checkFailure).toBeUndefined();
  });
  it("cancelled recurring failure does not claim to keep checking", () => {
    const result = scheduledReminder({ ...row, state: "cancelled", read_outcome: "refused" });
    expect(result.state).toBe("cancelled");
    expect(result.checkFailure).toBeUndefined();
  });
  it("a failed one-time read retains its existing terminal presentation", () => {
    expect(
      scheduledReminder({ ...row, repeat_kind: null, repeat_seconds: null, read_outcome: "failed" })
        .state
    ).toBe("failed");
  });
});

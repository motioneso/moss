import { describe, expect, it } from "vitest";
import { scheduledReminder } from "../../packages/chat/src/reminders/settings.js";

const row = {
  id: "reminder",
  reminder_text: "**Stretch**",
  state: "queued" as const,
  thread_id: "main",
  due_at: new Date("2026-10-11T12:00:00Z"),
  deadline_at: null,
  created_at: new Date("2026-10-11T11:00:00Z"),
  delivered_at: null,
  expired_at: null,
  late: null,
  message_id: null,
  message_body: null
};

describe("Settings reminder records", () => {
  it.each(["success", "refused", "failed", null] as const)(
    "grants a Tasks link only for a successful recorded read: %s",
    (read_outcome) => {
      const task = scheduledReminder({
        ...row,
        state: "delivered",
        delivered_at: row.due_at,
        message_id: "message",
        message_body: "[Source: Tasks](/tasks)",
        read_outcome
      });
      expect(task.runs[0]?.message?.scheduledReadSource).toBe(
        read_outcome === "success" ? "tasks" : undefined
      );
    }
  );
  it("lists an active reminder without pretending saving was a run", () => {
    expect(scheduledReminder(row)).toMatchObject({ group: "Reminders", state: "active", runs: [] });
  });
  it("uses the recorded delivery date and exact saved message", () => {
    const task = scheduledReminder({
      ...row,
      state: "delivered",
      delivered_at: row.due_at,
      late: true,
      message_id: "message",
      message_body: "Reminder: **Stretch**"
    });
    expect(task.state).toBe("completed");
    expect(task.runs).toEqual([
      {
        at: row.due_at.toISOString(),
        outcome: "delivered",
        summary: "Reminder delivered late",
        message: { id: "message", threadId: "main", body: "Reminder: **Stretch**" }
      }
    ]);
  });
  it("records expiration and never invents a failure or cancellation run date", () => {
    expect(
      scheduledReminder({ ...row, state: "expired", expired_at: row.due_at }).runs[0]
    ).toMatchObject({ at: row.due_at.toISOString(), outcome: "expired", message: null });
    for (const state of ["failed", "cancelled"] as const) {
      expect(scheduledReminder({ ...row, state }).runs).toEqual([]);
    }
  });
  it("keeps delivered history when its message is no longer available", () => {
    expect(
      scheduledReminder({ ...row, state: "delivered", delivered_at: row.due_at }).runs[0]?.message
    ).toBeNull();
  });
});

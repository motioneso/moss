import { reminderSummarySnapshot } from "../../packages/chat/src/reminders/summary/tool.js";
import type { ReminderSummary } from "../../packages/chat/src/reminders/summary/types.js";
export const reminderNow = "2026-10-24T01:00:00.000Z";
export function reminderFixture(overrides: Partial<ReminderSummary> = {}): ReminderSummary {
  return {
    scope: "upcoming",
    timeZone: "America/Los_Angeles",
    localDate: "2026-10-23",
    retrievedAt: reminderNow,
    truncated: false,
    items: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        text: "Call the dentist",
        state: "queued",
        contextState: "pending",
        timing: "local_clock",
        dueAt: "2026-10-24T16:00:00.000Z",
        dueLocalDay: "2026-10-24",
        deadlineAt: null,
        repeat: null,
        destinationTitle: null,
        deliveredAt: null,
        late: null,
        createdAt: reminderNow
      }
    ],
    ...overrides
  };
}
export function reminderSnapshot(overrides: Partial<ReminderSummary> = {}) {
  return { ref: "reminder-fixture", ...reminderSummarySnapshot(reminderFixture(overrides)) };
}

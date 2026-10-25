import { taskSummarySnapshot } from "../../packages/tasks/src/summary/tool.js";
import type { TaskSummary } from "../../packages/tasks/src/summary/types.js";
export const summaryNow = "2026-10-24T01:00:00.000Z";
export function summaryFixture(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    scope: "today",
    timeZone: "America/Los_Angeles",
    localDate: "2026-10-23",
    retrievedAt: summaryNow,
    truncated: false,
    items: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        title: "Draft proposal",
        status: "todo",
        priority: 4,
        dueAt: "2026-10-23T19:00:00.000Z",
        dueState: "today",
        completedAt: null,
        updatedAt: summaryNow,
        recurring: false
      }
    ],
    ...overrides
  };
}
export function summarySnapshot(overrides: Partial<TaskSummary> = {}) {
  return { ref: "summary-fixture", ...taskSummarySnapshot(summaryFixture(overrides)) };
}

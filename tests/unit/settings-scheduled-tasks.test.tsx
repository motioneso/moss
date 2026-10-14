import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ScheduledTaskDto } from "@moss/shared";
import { ScheduledTaskList } from "../../apps/web/src/settings/scheduled-task-list.js";
import { TaskDestination } from "../../apps/web/src/settings/scheduled-task-details/destination.js";
import { TaskTiming } from "../../apps/web/src/settings/scheduled-task-details/timing.js";
import { TaskStatus } from "../../apps/web/src/settings/scheduled-task-details/status.js";
import { TaskHistory } from "../../apps/web/src/settings/scheduled-task-details/history.js";
import { ScheduledTasksPane } from "../../apps/web/src/settings/settings-scheduled-tasks-pane.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
const task: ScheduledTaskDto = {
  id: "one",
  title: "Stretch",
  instruction: "Stretch",
  group: "Reminders",
  state: "active",
  dueAt: "2026-10-11T12:00:00Z",
  deadlineAt: "2026-10-11T13:00:00Z",
  createdAt: "2026-10-11T11:00:00Z",
  runs: []
};
const locale = { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "12" } as const;
function render(node: React.ReactNode, client = new QueryClient()) {
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        ChatControlsProvider,
        {
          value: {
            openChat: () => {},
            openChatThread: () => {},
            openChatWith: () => {},
            openAssistantWithDraft: () => {}
          }
        },
        node
      )
    )
  );
}

describe("read-only scheduled tasks", () => {
  it("shows a non-default destination and actionable delivery failure", () => {
    const destination = { threadId: "side", title: "Travel" };
    expect(render(createElement(TaskDestination, { task, locale }))).toBe("");
    expect(
      render(createElement(TaskDestination, { task: { ...task, destination }, locale }))
    ).toContain("Travel");
    expect(
      render(createElement(TaskStatus, { task: { ...task, destination, state: "failed" }, locale }))
    ).toContain("set it again with an available chat or Main");
  });
  it("groups reminder rows and keeps Past tasks collapsed", () => {
    const html = render(
      createElement(ScheduledTaskList, {
        tasks: [task, { ...task, id: "past", state: "completed" }],
        onSelect: () => {}
      })
    );
    expect(html).toContain("Reminders");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Past tasks");
    expect(html).toContain("hidden=");
  });
  it("shows paused and failed states without lifecycle controls", () => {
    const html = render(createElement(TaskStatus, { task: { ...task, state: "paused" }, locale }));
    expect(html).toContain("Paused");
    expect(html).not.toContain("<button");
    expect(
      render(createElement(TaskStatus, { task: { ...task, state: "failed" }, locale }))
    ).toContain("set it again");
  });
  it("omits obsolete scheduling facts from past tasks", () => {
    expect(render(createElement(TaskTiming, { task, locale }))).toContain("Not after");
    for (const state of ["completed", "expired", "cancelled"] as const) {
      expect(render(createElement(TaskTiming, { task: { ...task, state }, locale }))).toBe("");
    }
  });
  it("offers View message only when a result really exists", () => {
    const run = {
      at: task.dueAt,
      outcome: "delivered" as const,
      summary: "Reminder delivered",
      message: null
    };
    expect(
      render(createElement(TaskHistory, { task: { ...task, runs: [run] }, locale }))
    ).not.toContain("View message");
    expect(
      render(
        createElement(TaskHistory, {
          task: {
            ...task,
            runs: [{ ...run, message: { id: "m", threadId: "main", body: "Reminder" } }]
          },
          locale
        })
      )
    ).toContain("View message");
  });
  it("renders loading and an actionable empty state", () => {
    expect(render(createElement(ScheduledTasksPane))).toContain("Loading your scheduled tasks");
    const client = new QueryClient();
    client.setQueryData(queryKeys.chat.scheduledTasks, { tasks: [] });
    const html = render(createElement(ScheduledTasksPane), client);
    expect(html).toContain("Nothing scheduled yet");
    expect(html).toContain("Open chat");
  });
  it("renders a retry for load failures instead of pretending the list is empty", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } }
    });
    client
      .getQueryCache()
      .build(client, { queryKey: queryKeys.chat.scheduledTasks })
      .setState({ status: "error", error: new Error("unavailable") });
    const html = render(createElement(ScheduledTasksPane), client);
    expect(html).toContain("load your tasks");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Nothing scheduled yet");
  });
});

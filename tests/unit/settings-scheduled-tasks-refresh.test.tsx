// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import * as api from "../../apps/web/src/api/client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import { ScheduledTasksPane } from "../../apps/web/src/settings/settings-scheduled-tasks-pane.js";

it("keeps the loaded list, open detail and saved message when a background refresh fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const refresh = vi.spyOn(api, "listScheduledTasks").mockRejectedValue(new Error("offline"));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  client.setQueryData(queryKeys.chat.scheduledTasks, {
    tasks: [
      {
        id: "reminder",
        title: "Stretch",
        instruction: "Stretch",
        group: "Reminders",
        state: "completed",
        dueAt: "2026-10-11T12:00:00Z",
        deadlineAt: null,
        createdAt: "2026-10-11T11:00:00Z",
        runs: [
          {
            at: "2026-10-11T12:00:00Z",
            outcome: "delivered",
            summary: "Reminder delivered",
            message: { id: "message", threadId: "main", body: "Saved **stretch** result" }
          }
        ]
      }
    ]
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string) =>
    Array.from(document.querySelectorAll("button")).find((node) => node.textContent === name)!;
  const failRefresh = async () => {
    await act(async () => {
      await client.refetchQueries({ queryKey: queryKeys.chat.scheduledTasks });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.getQueryState(queryKeys.chat.scheduledTasks)?.status).toBe("error");
    expect(document.body.textContent).not.toContain("Couldn't load your tasks");
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            ChatControlsProvider,
            {
              value: {
                openChat: vi.fn(),
                openChatThread: vi.fn(),
                openChatWith: vi.fn(),
                openAssistantWithDraft: vi.fn()
              }
            },
            createElement(ScheduledTasksPane)
          )
        )
      )
    );
    await failRefresh();
    expect(container.querySelector('[data-task-id="reminder"]')).not.toBeNull();
    await act(async () => button("Past tasks").click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-task-id="reminder"]')!.click()
    );
    await act(async () => button("View message").click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector("strong")?.textContent).toBe("stretch");
    await failRefresh();
    expect(button("Back to all tasks")).toBeDefined();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog?.textContent).toContain("Saved stretch result");
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("deletion restores focus to a surviving control after the list refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  client.setQueryData(queryKeys.chat.scheduledTasks, {
    tasks: [
      {
        id: "delete-focus",
        title: "Delete focus",
        instruction: "Delete focus",
        group: "Reminders",
        state: "active",
        dueAt: "2026-10-11T12:00:00Z",
        deadlineAt: null,
        createdAt: "2026-10-11T11:00:00Z",
        runs: []
      }
    ]
  });
  let finishRefresh!: () => void;
  const refreshed = new Promise<{ tasks: [] }>((resolve) => {
    finishRefresh = () => resolve({ tasks: [] });
  });
  vi.spyOn(api, "listScheduledTasks").mockImplementation(() => refreshed);
  vi.spyOn(api, "deleteScheduledTask").mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string) =>
    Array.from(container.querySelectorAll("button")).find((node) => node.textContent === name)!;
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            ChatControlsProvider,
            {
              value: {
                openChat: vi.fn(),
                openChatThread: vi.fn(),
                openChatWith: vi.fn(),
                openAssistantWithDraft: vi.fn()
              }
            },
            createElement(ScheduledTasksPane)
          )
        )
      )
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-task-id="delete-focus"]')!.click()
    );
    await act(async () => button("Delete task").click());
    await act(async () =>
      Array.from(container.querySelectorAll('[role="dialog"] button'))
        .find((node) => node.textContent === "Delete task")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0));
    });
    await act(async () => {
      finishRefresh();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      frames.splice(0).forEach((frame) => frame(0));
    });
    expect(container.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe("Open chat");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ScheduledTaskDto } from "@moss/shared";
import { ScheduledTaskDetail } from "../../apps/web/src/settings/scheduled-task-detail.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";

const task: ScheduledTaskDto = {
  id: "reminder",
  title: "Stretch",
  instruction: "Stretch",
  group: "Reminders",
  state: "active",
  dueAt: "2026-10-11T12:00:00Z",
  deadlineAt: null,
  createdAt: "2026-10-11T11:00:00Z",
  runs: []
};

describe("Settings reminder controls", () => {
  it("offers pause and deletion, with initial confirmation focus on Keep task", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(queryKeys.settings.locale, {
      locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
    });
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
                  openChat: () => {},
                  openChatThread: () => {},
                  openChatWith: () => {},
                  openAssistantWithDraft: () => {}
                }
              },
              createElement(ScheduledTaskDetail, { task, onBack: () => {} })
            )
          )
        )
      );
      const button = (name: string) =>
        [...container.querySelectorAll("button")].find((el) => el.textContent === name);
      expect(button("Pause")).toBeDefined();
      expect(button("Delete task")).toBeDefined();
      await act(async () => button("Delete task")!.click());
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.activeElement?.textContent).toBe("Keep task");
      await act(async () => button("Keep task")!.click());
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

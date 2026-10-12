// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import { QuietHoursAllowances } from "../../apps/web/src/settings/settings-quiet-hours-allowances.js";

afterEach(() => vi.restoreAllMocks());
function fixture(data?: {
  mainThreadId: string | null;
  allowances: { id: string; title: string }[];
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  if (data) client.setQueryData(queryKeys.chat.quietHoursAllowances, data);
  const openChatThread = vi.fn();
  const view = createElement(
    QueryClientProvider,
    { client },
    createElement(
      ChatControlsProvider,
      {
        value: {
          openChat: vi.fn(),
          openChatThread,
          openChatWith: vi.fn(),
          openAssistantWithDraft: vi.fn()
        }
      },
      createElement(QuietHoursAllowances)
    )
  );
  return { client, view, openChatThread };
}

describe("saved task allowances in Settings", () => {
  it("does not leave an issue-specific integration script in the root package", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts).not.toHaveProperty("test:integration:3145");
  });
  it("shows a loading state instead of pretending no tasks are allowed", () => {
    const html = renderToString(fixture().view);
    expect(html).toContain("Loading allowed tasks");
    expect(html).not.toContain("No tasks are allowed");
  });
  it("shows an empty choice and ordinary chat entry", () => {
    const html = renderToString(fixture({ mainThreadId: "main", allowances: [] }).view);
    expect(html).toContain("Allowed during quiet hours");
    expect(html).toContain("No tasks are allowed during quiet hours.");
    expect(html).toContain("Change in chat");
    expect(html).not.toContain("Loading allowed tasks");
  });
  it("renders saved titles as text and keeps other delivery controls in force", () => {
    const html = renderToString(
      fixture({ mainThreadId: "main", allowances: [{ id: "r", title: "<private reminder>" }] }).view
    );
    expect(html).toContain("&lt;private reminder&gt;");
    expect(html).not.toContain("<private reminder>");
    expect(html).toContain("Module mutes and device delivery controls still apply.");
  });
  it("offers retry and chat when the read fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
    const f = fixture();
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(f.view);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const rendered = JSON.stringify(tree!.toJSON());
    expect(rendered).toContain("Could not load allowed tasks");
    expect(rendered).toContain("Try again");
    expect(rendered).not.toContain("No tasks are allowed");
    const change = tree!.root
      .findAllByType("button")
      .find((node) => node.children.includes("Change in chat"))!;
    expect(change.props.disabled).not.toBe(true);
    await act(async () => {
      change.props.onClick();
      tree!.unmount();
    });
    f.client.clear();
  });
  it("refreshes on focus and remount without polling", async () => {
    vi.useFakeTimers();
    const data = { mainThreadId: "main", allowances: [] };
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(data)));
    const f = fixture(data);
    f.client.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
    focusManager.setFocused(true);
    let tree: ReturnType<typeof create>;
    try {
      await act(async () => {
        tree = create(f.view);
      });
      const initial = fetch.mock.calls.length;
      expect(initial).toBeGreaterThan(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(fetch).toHaveBeenCalledTimes(initial);
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      expect(fetch).toHaveBeenCalledTimes(initial + 1);
      await act(async () => {
        tree!.unmount();
        tree = create(f.view);
      });
      expect(fetch).toHaveBeenCalledTimes(initial + 2);
      await act(async () => {
        tree!.unmount();
      });
    } finally {
      f.client.clear();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });
  it("opens Main even when a different conversation is active", async () => {
    const data = { mainThreadId: "main", allowances: [{ id: "r", title: "stretch" }] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(data)));
    const f = fixture(data);
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(f.view);
    });
    const button = tree!.root
      .findAllByType("button")
      .find((node) => node.children.includes("Change in chat"))!;
    await act(async () => {
      button.props.onClick();
    });
    expect(f.openChatThread).toHaveBeenCalledWith("main");
    await act(async () => {
      tree!.unmount();
    });
    f.client.clear();
  });
});

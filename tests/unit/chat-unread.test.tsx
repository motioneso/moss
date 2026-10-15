import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRecord } from "@moss/shared";
import {
  ChatUnreadBadge,
  unreadMessageDescription
} from "../../apps/web/src/chat/chat-unread-badge.js";
import { useReadChatMessages } from "../../apps/web/src/chat/use-chat-unread.js";
import { markChatMessagesRead } from "../../apps/web/src/api/chat-unread-client.js";

vi.mock("../../apps/web/src/api/chat-unread-client.js", () => ({
  getChatUnread: vi.fn(async () => ({ unreadCount: 0, unreadByThread: {} })),
  markChatMessagesRead: vi.fn(async () => ({ ok: true }))
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("chat unread badge and visible read acknowledgements", () => {
  it("hides zero, caps large visual counts, and describes exact counts", () => {
    expect(renderToStaticMarkup(createElement(ChatUnreadBadge, { count: 0 }))).toBe("");
    expect(renderToStaticMarkup(createElement(ChatUnreadBadge, { count: 134 }))).toContain("99+");
    expect(unreadMessageDescription(134)).toBe("134 unread messages");
    expect(unreadMessageDescription(1)).toBe("1 unread message");
  });

  it("keeps closed/hidden messages unread, then acknowledges only loaded replies in the visible conversation", async () => {
    const events = new EventTarget();
    const doc = Object.assign(events, { visibilityState: "visible" });
    vi.stubGlobal("document", doc);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const loaded: readonly TranscriptRecord[] = [
      { kind: "reply", text: "Reminder", messageId: "saved-reply" },
      { kind: "reply", text: "Reminder", messageId: "saved-reply" },
      { kind: "user", text: "Question", messageId: "user-message" },
      { kind: "thinking", text: "Working", messageId: "progress" },
      { kind: "reply", text: "Partial reply" }
    ];
    function Harness(props: {
      visible: boolean;
      threadId: string;
      records?: readonly TranscriptRecord[];
    }) {
      useReadChatMessages({
        ownerId: "owner",
        threadId: props.threadId,
        visible: props.visible,
        records: props.records ?? loaded
      });
      return null;
    }
    const tree = (visible: boolean, threadId = "main", records?: readonly TranscriptRecord[]) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, { visible, threadId, records })
      );
    await act(async () => {
      renderer = create(tree(false));
    });
    expect(markChatMessagesRead).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    await act(async () => {
      doc.dispatchEvent(new Event("visibilitychange"));
      renderer!.update(tree(true));
    });
    expect(markChatMessagesRead).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    await act(async () => {
      doc.dispatchEvent(new Event("visibilitychange"));
    });
    expect(markChatMessagesRead).toHaveBeenCalledExactlyOnceWith("main", ["saved-reply"]);
    await act(async () => {
      renderer!.update(tree(true));
    });
    expect(markChatMessagesRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.update(
        tree(true, "side", [{ kind: "reply", text: "Side", messageId: "side-reply" }])
      );
    });
    expect(markChatMessagesRead).toHaveBeenLastCalledWith("side", ["side-reply"]);
    client.clear();
  });

  it("retries a failed acknowledgement only while the loaded conversation remains visible", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.mocked(markChatMessagesRead).mockRejectedValueOnce(new Error("offline"));
    const client = new QueryClient();
    function Harness({ visible }: { visible: boolean }) {
      useReadChatMessages({
        ownerId: "owner",
        threadId: "main",
        visible,
        records: [{ kind: "reply", text: "Saved", messageId: "saved" }]
      });
      return null;
    }
    const tree = (visible: boolean) =>
      createElement(QueryClientProvider, { client }, createElement(Harness, { visible }));
    await act(async () => {
      renderer = create(tree(true));
    });
    expect(markChatMessagesRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.update(tree(false));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(markChatMessagesRead).toHaveBeenCalledTimes(1);
    vi.mocked(markChatMessagesRead).mockRejectedValueOnce(new Error("offline again"));
    await act(async () => {
      renderer!.update(tree(true));
    });
    expect(markChatMessagesRead).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(markChatMessagesRead).toHaveBeenCalledTimes(3);
    client.clear();
  });
});

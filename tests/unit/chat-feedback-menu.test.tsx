// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Thread } from "../../apps/web/src/chat/message-row.js";
import type { TranscriptRecord } from "../../apps/web/src/chat/use-chat-stream.js";

const REPLY_RECORD: TranscriptRecord = {
  kind: "reply",
  text: "Here is the answer.",
  messageId: "message-1"
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <Thread records={[REPLY_RECORD]} />
      </QueryClientProvider>
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const trigger = () => document.querySelector<HTMLButtonElement>('[aria-label="Feedback"]')!;
const list = () => document.querySelector('[role="menu"]');

// This exercises the real chat reply row, not just the shared Menu primitive — the old
// <details>-based feedback menu never listened for an outside click or Escape at all, so
// these assertions fail on that version and only pass once chat actually uses Menu.
describe("chat reply feedback menu", () => {
  it("closes on an outside click, which still reaches the control that was clicked", () => {
    const outsideClick = vi.fn();
    const outsideButton = document.createElement("button");
    outsideButton.addEventListener("click", outsideClick);
    document.body.appendChild(outsideButton);

    mount();
    act(() => trigger().click());
    expect(list()).not.toBeNull();

    act(() => {
      outsideButton.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      outsideButton.click();
    });

    expect(list()).toBeNull();
    expect(outsideClick).toHaveBeenCalledOnce();

    outsideButton.remove();
  });

  it("closes on Escape and returns focus to the feedback trigger", () => {
    mount();
    act(() => trigger().click());
    expect(list()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(list()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});

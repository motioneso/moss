import { createElement, useState, type ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { ChatThreadDto } from "@moss/shared";

import { SideChatOverlay } from "../../apps/web/src/chat/side-chat-overlay.js";

vi.stubGlobal("document", {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
});

const threads: readonly ChatThreadDto[] = [
  {
    id: "main",
    ownerUserId: "user-1",
    title: "Main",
    incognito: false,
    isMain: true,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    lastActiveAt: "2026-10-09T00:00:00.000Z",
    lastMessagePreview: null
  },
  {
    id: "side",
    ownerUserId: "user-1",
    title: "Kitchen plans",
    incognito: false,
    isMain: false,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    lastActiveAt: "2026-10-09T00:00:00.000Z",
    lastMessagePreview: "Countertops"
  }
];

function openOverlay(renderer: ReactTestRenderer): void {
  const trigger = renderer.root.findByProps({ "aria-label": "Open conversations" });
  trigger.props.onClick();
}

function ControlledOverlay(
  props: Omit<ComponentProps<typeof SideChatOverlay>, "open" | "onOpenChange">
) {
  const [open, setOpen] = useState(false);
  return createElement(SideChatOverlay, { ...props, open, onOpenChange: setOpen });
}

async function renderOverlay(props?: {
  readonly onSelect?: (threadId: string) => void;
}): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ControlledOverlay, {
        threads,
        selectedThreadId: "main",
        onSelect: props?.onSelect ?? vi.fn(),
        onNewSideChat: vi.fn(),
        disabled: false
      })
    );
  });
  return renderer;
}

describe("SideChatOverlay (#3126)", () => {
  it("keeps the conversation list closed until the three-line trigger opens it", async () => {
    const renderer = await renderOverlay();

    expect(renderer.root.findAllByProps({ "aria-label": "Conversations" })).toHaveLength(0);

    await act(async () => openOverlay(renderer));

    expect(renderer.root.findAllByProps({ "aria-label": "Conversations" })).toHaveLength(1);
    expect(renderer.root.findByProps({ "aria-label": "Main chat" }).props["aria-pressed"]).toBe(
      true
    );
    expect(renderer.root.findByProps({ "aria-label": "Kitchen plans" })).toBeDefined();
  });

  it("selects a side chat and closes the overlay", async () => {
    const onSelect = vi.fn();
    const renderer = await renderOverlay({ onSelect });

    await act(async () => openOverlay(renderer));
    await act(async () =>
      renderer.root.findByProps({ "aria-label": "Kitchen plans" }).props.onClick()
    );

    expect(onSelect).toHaveBeenCalledWith("side");
    expect(renderer.root.findAllByProps({ "aria-label": "Conversations" })).toHaveLength(0);
  });

  it("shows a retry action instead of an empty state when loading fails", async () => {
    const onRetry = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(ControlledOverlay, {
          threads: [],
          selectedThreadId: null,
          onSelect: vi.fn(),
          onNewSideChat: vi.fn(),
          onRetry,
          error: true,
          disabled: false
        })
      );
    });

    await act(async () => openOverlay(renderer));
    expect(
      renderer.root.findAll((node) => node.children.includes("Could not load conversations."))
    ).not.toHaveLength(0);
    await act(async () => renderer.root.findByProps({ children: "Retry" }).props.onClick());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

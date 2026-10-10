import { createElement, type ReactElement } from "react";
import { act, create } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "../../apps/web/src/chat/composer.js";

async function mountComposer(onSend: () => boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createElement(
    QueryClientProvider,
    { client },
    createElement(Composer, {
      readOnly: false,
      isFounder: false,
      isSending: false,
      sendError: null,
      needsProvider: false,
      lockedModelUnavailable: false,
      privateMode: false,
      queuedText: null,
      initialText: "keep this draft",
      onSend,
      onQueue: () => {},
      onDiscardQueuedText: () => {},
      onStop: () => {}
    }) as ReactElement
  );
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree);
  });
  return renderer;
}

function pressEnter(renderer: ReturnType<typeof create>) {
  const box = renderer.root.find((n) => n.type === "textarea");
  act(() => {
    box.props.onKeyDown({ key: "Enter", shiftKey: false, preventDefault: () => {} });
  });
  return renderer.root.find((n) => n.type === "textarea").props.value as string;
}

describe("Composer send refusal (WEB-01)", () => {
  it("keeps the draft when the send is refused", async () => {
    const onSend = vi.fn(() => false);
    const renderer = await mountComposer(onSend);
    expect(pressEnter(renderer)).toBe("keep this draft");
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("clears the draft when the send is accepted", async () => {
    const renderer = await mountComposer(() => true);
    expect(pressEnter(renderer)).toBe("");
  });
});

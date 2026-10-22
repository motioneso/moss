import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ChatSurface } from "@moss/shared";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

export function buildElement(
  client: QueryClient,
  surface: ChatSurface,
  clearRecords: () => void,
  open = true,
  initialText?: string
): ReactElement {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      MemoryRouter,
      null,
      createElement(ChatDrawer, {
        open,
        onClose: () => undefined,
        records: [],
        clearRecords,
        streamErrorCount: 0,
        isFounder: false,
        initialText,
        surface
      }) as ReactElement
    )
  );
}
export async function mountWithClient(
  client: QueryClient,
  surface: ChatSurface,
  clearRecords: () => void
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(buildElement(client, surface, clearRecords));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}
export async function flipSurface(
  renderer: ReactTestRenderer,
  client: QueryClient,
  surface: ChatSurface,
  clearRecords: () => void
): Promise<void> {
  await act(async () => {
    renderer.update(buildElement(client, surface, clearRecords));
    await Promise.resolve();
    await Promise.resolve();
  });
}

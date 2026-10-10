// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CHAT_SURFACE, type LookupAiCapabilityRouteResponse } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

function render(
  route: LookupAiCapabilityRouteResponse,
  options?: { readonly initialText?: string }
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.ai.capability("chat"), route);
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(ChatDrawer, {
          open: true,
          onClose: () => {},
          records: [],
          clearRecords: () => {},
          streamErrorCount: 0,
          isFounder: false,
          surface: DEFAULT_CHAT_SURFACE,
          initialText: options?.initialText
        })
      )
    )
  );
}

const noModel: LookupAiCapabilityRouteResponse = {
  route: { capability: "chat", available: false, reason: "no-active-model", model: null }
};

const lockedModel: LookupAiCapabilityRouteResponse = {
  route: { capability: "chat", available: false, reason: "admin-pin-unavailable", model: null }
};

const workingModel = {
  route: { capability: "chat", available: true, reason: null, model: null }
} as never;

type MountOptions = {
  readonly cached: LookupAiCapabilityRouteResponse;
  // The answer the open-time recheck returns. Undefined leaves the recheck pending.
  readonly fresh?: LookupAiCapabilityRouteResponse;
};

// Unmounts every drawer a test mounted, including when an assertion fails before the test ends.
const mountedDrawers: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const view of mountedDrawers.splice(0)) view.unmount();
});

// Mounts the drawer the way a user opens it: a cached answer, then a recheck.
async function mountDrawer({ cached, fresh }: MountOptions) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
    fresh && String(input).includes("/capability-route/")
      ? Promise.resolve(Response.json(fresh))
      : new Promise(() => {})
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const originalScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = () => {};

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.ai.capability("chat"), cached);
  const container = document.createElement("div");
  document.body.appendChild(container);

  // Records the page text after every committed change, so a brief wrong state is caught.
  const seenText: string[] = [];
  const observer = new MutationObserver(() => seenText.push(container.textContent ?? ""));
  observer.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true
  });

  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(ChatDrawer, {
            open: true,
            onClose: () => {},
            records: [],
            clearRecords: () => {},
            streamErrorCount: 0,
            isFounder: false,
            surface: DEFAULT_CHAT_SURFACE
          })
        )
      )
    );
  });

  const view = {
    container,
    seenText,
    settle: (text: string) =>
      act(async () => {
        await vi.waitFor(() => expect(container.textContent).toContain(text));
      }),
    unmount: () => {
      observer.disconnect();
      act(() => root.unmount());
      container.remove();
      Element.prototype.scrollTo = originalScrollTo;
      vi.unstubAllGlobals();
    }
  };
  mountedDrawers.push(view);
  return view;
}

describe("ChatDrawer unavailable routes (rendered)", () => {
  it("renders the locked-model warning instead of provider setup", async () => {
    const view = await mountDrawer({ cached: lockedModel, fresh: lockedModel });
    await view.settle("The locked chat model is unavailable");

    expect(view.container.textContent).toContain("Model unavailable");
    expect(view.container.textContent).not.toContain("Here when you need me");
    expect(view.container.textContent).not.toContain("Connect a provider to start chatting");
  });

  it("renders provider setup when no chat model is available", async () => {
    const view = await mountDrawer({ cached: noModel, fresh: noModel });
    await view.settle("Connect a provider to start chatting");
  });

  it("says no model is connected and replaces the message box when none is available", async () => {
    const view = await mountDrawer({ cached: noModel, fresh: noModel });
    await view.settle("Not connected");

    expect(view.container.textContent).not.toContain("Here when you need me");
    expect(view.container.querySelector("textarea")).toBeNull();
    expect(view.container.querySelector(".chatd-connect-cta")).not.toBeNull();
  });

  it("keeps the ready status and message box when a model is available", () => {
    const html = render({
      route: { capability: "chat", available: true, reason: null, model: null } as never
    });

    expect(html).toContain("Here when you need me");
    expect(html).toContain("<textarea");
    expect(html).not.toContain("chatd-connect-cta");
  });

  it("keeps a started draft instead of swapping in the connect link (#2939)", () => {
    const html = render(
      {
        route: { capability: "chat", available: false, reason: "no-active-model", model: null }
      },
      { initialText: "Say hello in three words." }
    );

    expect(html).toContain("<textarea");
    expect(html).not.toContain("chatd-connect-cta");
  });
});

describe("ChatDrawer recheck on open (#3324)", () => {
  it("shows a neutral state, not the connect prompt, while a stale no-model answer is rechecked", async () => {
    const view = await mountDrawer({ cached: noModel });

    expect(view.container.textContent).toContain("Checking connection");
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(view.seenText.some((text) => text.includes("Connect a provider"))).toBe(false);
    expect(view.seenText.some((text) => text.includes("Not connected"))).toBe(false);
  });

  it("never shows the connect prompt when a model was added after the stale answer", async () => {
    const view = await mountDrawer({ cached: noModel, fresh: workingModel });
    await view.settle("Here when you need me");

    expect(view.seenText.some((text) => text.includes("Connect a provider"))).toBe(false);
    expect(view.container.querySelector("textarea")).not.toBeNull();
  });
});

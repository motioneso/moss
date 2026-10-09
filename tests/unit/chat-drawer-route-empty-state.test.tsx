import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

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

describe("ChatDrawer unavailable routes (rendered)", () => {
  it("renders the locked-model warning instead of provider setup", () => {
    const html = render({
      route: { capability: "chat", available: false, reason: "admin-pin-unavailable", model: null }
    });

    expect(html).toContain("The locked chat model is unavailable");
    expect(html).toContain("Model unavailable");
    expect(html).not.toContain("Here when you need me");
    expect(html).not.toContain("Connect a provider to start chatting");
  });

  it("renders provider setup when no chat model is available", () => {
    const html = render({
      route: { capability: "chat", available: false, reason: "no-active-model", model: null }
    });

    expect(html).toContain("Connect a provider to start chatting");
  });

  it("says no model is connected and replaces the message box when none is available", () => {
    const html = render({
      route: { capability: "chat", available: false, reason: "no-active-model", model: null }
    });

    expect(html).toContain("Not connected");
    expect(html).not.toContain("Here when you need me");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("chatd-connect-cta");
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
    expect(html).toContain("Say hello in three words.");
    expect(html).not.toContain("chatd-connect-cta");
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_SURFACE, type LookupAiCapabilityRouteResponse } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatDrawer } from "../../apps/web/src/chat/chat-drawer.js";

function render(route: LookupAiCapabilityRouteResponse): string {
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
          surface: DEFAULT_CHAT_SURFACE
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
    expect(html).not.toContain("Connect a provider to start chatting");
  });

  it("renders provider setup when no chat model is available", () => {
    const html = render({
      route: { capability: "chat", available: false, reason: "no-active-model", model: null }
    });

    expect(html).toContain("Connect a provider to start chatting");
  });
});

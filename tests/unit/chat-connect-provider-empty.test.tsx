import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { ConnectProviderEmpty } from "../../apps/web/src/chat/connect-provider-empty.js";

// ConnectProviderEmpty reads the configured assistant name via useAssistantName (react-query), so
// rendering it needs a QueryClientProvider ancestor. No cache priming here — none of these
// assertions inspect the assistant name, only the explainer copy and settings deep-link.
function render(props: { isFounder: boolean }): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(ConnectProviderEmpty, props))
    )
  );
}

describe("ConnectProviderEmpty (rendered)", () => {
  it("shows the connect-a-provider explainer, not the raw backend error", () => {
    const html = render({ isFounder: true });
    expect(html.toLowerCase()).toContain("connect a provider to start chatting");
    expect(html).not.toContain("No active chat-capable model is configured");
  });

  it("renders a direct link to the assistant/AI settings (deep-linked) for any user", () => {
    const html = render({ isFounder: false });
    // Deep-link carries the assistant section so the user lands on Assistant & AI, not Profile.
    expect(html).toContain("/settings?section=assistant");
  });

  it("offers a connect link for the founder too", () => {
    const html = render({ isFounder: true });
    expect(html).toContain("/settings?section=assistant");
    expect(html.toLowerCase()).toContain("connect");
  });

  it("shows neutral copy, not the product name, while the persona fetch is still pending (#1482)", () => {
    // render() above never primes the persona query cache, so this renders mid-fetch — the exact
    // window that used to flash "Moss" before the configured assistant name resolved.
    const html = render({ isFounder: true });
    expect(html).not.toContain("Moss");
    expect(html).toContain("Connect one to start chatting.");
  });
});

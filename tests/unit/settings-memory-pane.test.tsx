import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { MemoryPane } from "../../apps/web/src/settings/settings-memory-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

function renderPane(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        FeedbackProvider,
        null,
        createElement(MemoryPane, {
          me: {} as never,
          onNavigate: () => undefined
        })
      )
    )
  );
}

describe("MemoryPane", () => {
  it("shows memory records without feature toggles", () => {
    const html = renderPane();
    expect(html).toContain("Memory dashboard");
    expect(html).not.toContain("Conversation recall");
    expect(html).not.toContain("Learn patterns");
  });
});

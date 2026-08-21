import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { WorkshopPage } from "../../packages/workshop/src/web/workshop-page.js";

// Root suite renders @moss/web components with react-dom/server (no jsdom /
// @testing-library — deliberately avoided repo-wide; see settings-appearance-pane.test.tsx).

function render(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(createElement(QueryClientProvider, { client }, createElement(WorkshopPage)));
}

describe("WorkshopPage", () => {
  it("renders the page title with no builds or modules", () => {
    const html = render();
    expect(html).toContain("The workshop");
  });

  it("falls back to the empty state when nothing is building or live", () => {
    const html = render();
    expect(html).toContain("Nothing in the workshop yet");
  });
});

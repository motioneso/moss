import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { MeResponse } from "@moss/shared";

import { WorkshopPage } from "../../packages/workshop/src/web/workshop-page.js";

// Root suite renders @moss/web components with react-dom/server (no jsdom /
// @testing-library — deliberately avoided repo-wide; see settings-appearance-pane.test.tsx).
// useQuery reads primed cache synchronously during renderToString, so the resolved
// state is asserted against the SSR HTML string.

function meResponse(isInstanceAdmin: boolean): MeResponse {
  return {
    user: {
      id: "u-1",
      email: "admin@example.com",
      emailVerified: true,
      name: "Admin",
      isInstanceAdmin,
      status: "active",
      isBootstrapOwner: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z"
    },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  };
}

function render(me?: MeResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (me) client.setQueryData(["workshop", "me"], me);
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(WorkshopPage))
  );
}

describe("WorkshopPage", () => {
  it("uses the shell title instead of repeating it in the page", () => {
    const html = render(meResponse(true));
    expect(html).not.toContain(">The workshop<");
    expect(html).toContain("See what Moss is building for you");
  });

  it("falls back to the empty state when nothing is building or live", () => {
    const html = render(meResponse(true));
    expect(html).toContain("Nothing in the workshop yet");
  });

  it("shows an access-denied empty state for a non-admin, not the workshop groups", () => {
    const html = render(meResponse(false));
    expect(html).toContain("The workshop is for instance admins");
    expect(html).not.toContain("Nothing in the workshop yet");
  });
});

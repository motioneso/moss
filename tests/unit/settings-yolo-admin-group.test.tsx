import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import { YoloAdminGroup } from "../../apps/web/src/settings/settings-yolo-admin-group.js";
import type { YoloAdminUserDto } from "@moss/shared";

function renderWithQuery(node: React.ReactNode, client: QueryClient): string {
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(FeedbackProvider, null, node))
  );
}

describe("YoloAdminGroup", () => {
  it("renders searchable add input and datalist for active members", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user: YoloAdminUserDto = {
      id: "usr-1",
      email: "test@example.com",
      name: "Test User",
      emailVerified: true,
      status: "active",
      yoloAllowed: false,
      yoloEnabled: false,
      yoloActive: false,
      isInstanceAdmin: false,
      isBootstrapOwner: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    client.setQueryData(queryKeys.settings.adminYolo, {
      instanceEnabled: false,
      users: [user]
    });

    const html = renderWithQuery(createElement(YoloAdminGroup), client);

    // Admin-only surface / Group title
    expect(html).toContain("YOLO / auto-approval");

    // Searchable input
    expect(html).toContain("Search members (Enter to add)");
    expect(html).toContain('list="yolo-active-candidates"');

    // Datalist population
    expect(html).toContain('value="test@example.com"');
    expect(html).toContain('label="Member"');
  });

  it("disables add input and changes placeholder when no active members", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.adminYolo, {
      instanceEnabled: false,
      users: []
    });

    const html = renderWithQuery(createElement(YoloAdminGroup), client);
    expect(html).toContain("No active members to add");
    expect(html).not.toContain("test@example.com");
  });

  it("renders allowed members with a remove button", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user: YoloAdminUserDto = {
      id: "usr-2",
      email: "allowed@example.com",
      name: "Allowed User",
      emailVerified: true,
      status: "active",
      yoloAllowed: true,
      yoloEnabled: true,
      yoloActive: true,
      isInstanceAdmin: true,
      isBootstrapOwner: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    client.setQueryData(queryKeys.settings.adminYolo, {
      instanceEnabled: false,
      users: [user]
    });

    const html = renderWithQuery(createElement(YoloAdminGroup), client);

    expect(html).toContain("allowed@example.com");
    expect(html).toContain("self-enabled");
    expect(html).toContain("Remove");
  });
});

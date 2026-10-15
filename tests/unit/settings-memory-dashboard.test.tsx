import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type {
  MemoryDashboardItem,
  MemoryDashboardResponse
} from "../../apps/web/src/api/memory-client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { MemoryDashboardPane } from "../../apps/web/src/settings/settings-memory-dashboard.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

function makeItem(overrides: Partial<MemoryDashboardItem> = {}): MemoryDashboardItem {
  return {
    itemKind: "candidate",
    id: "test-id-1",
    title: "user prefers dark mode",
    summary: "dark mode",
    status: "pending",
    sourceSummary: "chat",
    sourceKind: "chat",
    createdAt: "2026-06-27T00:00:00Z",
    updatedAt: "2026-06-27T00:00:00Z",
    editableFields: ["summary", "recordKind"],
    ...overrides
  };
}

function makeDashboardResponse(items: MemoryDashboardItem[] = []): MemoryDashboardResponse {
  return { counts: { pending: items.length }, items };
}

function renderWithQuery(node: React.ReactNode, client: QueryClient): string {
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(FeedbackProvider, null, node))
  );
}

describe("MemoryDashboardPane", () => {
  it("renders the tab control", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderWithQuery(createElement(MemoryDashboardPane), client);
    expect(html).toContain("To review");
    expect(html).toContain("Saved memories");
    expect(html).toContain("History");
  });

  it("shows pending count badge when candidates are present", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const item = makeItem();
    client.setQueryData(
      queryKeys.memory.dashboard({ status: "pending" }),
      makeDashboardResponse([item])
    );
    client.setQueryData(queryKeys.memory.dashboard({}), makeDashboardResponse([item]));
    const html = renderWithQuery(createElement(MemoryDashboardPane), client);
    expect(html).toContain("To review (1)");
  });

  it("renders empty state when no items", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      queryKeys.memory.dashboard({ status: "pending" }),
      makeDashboardResponse([])
    );
    client.setQueryData(queryKeys.memory.dashboard({}), makeDashboardResponse([]));
    const html = renderWithQuery(createElement(MemoryDashboardPane), client);
    expect(html).toContain("No memories to review.");
  });

  it("renders item row with kind and status badges", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const item = makeItem({
      itemKind: "fact",
      title: "user prefers light mode",
      status: "active",
      confidenceTier: "high",
      recordKind: "preference"
    });
    client.setQueryData(
      queryKeys.memory.dashboard({ status: "pending" }),
      makeDashboardResponse([item])
    );
    client.setQueryData(queryKeys.memory.dashboard({}), makeDashboardResponse([item]));
    const html = renderWithQuery(createElement(MemoryDashboardPane), client);
    expect(html).toContain("user prefers light mode");
    expect(html).toContain("fact");
    expect(html).toContain("preference");
    expect(html).toContain("high");
    expect(html).toContain("active");
  });

  it("renders entity item with entity kind", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const item = makeItem({
      itemKind: "entity",
      entityKind: "person",
      title: "Alice",
      status: "active"
    });
    client.setQueryData(
      queryKeys.memory.dashboard({ status: "pending" }),
      makeDashboardResponse([item])
    );
    client.setQueryData(queryKeys.memory.dashboard({}), makeDashboardResponse([item]));
    const html = renderWithQuery(createElement(MemoryDashboardPane), client);
    expect(html).toContain("Alice");
    expect(html).toContain("entity");
  });
});

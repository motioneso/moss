// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsPage } from "../../apps/web/src/notifications/notifications-page.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import type { NotificationDto } from "@moss/shared";

function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
  });
  queryClient.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  return queryClient;
}
function page(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
function notification(id: string): NotificationDto {
  return {
    id,
    moduleId: null,
    actorUserId: null,
    recipientUserId: "fixture",
    title: `Notice ${id}`,
    body: "A useful reminder",
    href: "/today",
    readAt: null,
    createdAt: "2026-10-10T12:00:00Z",
    metadata: {}
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("Notifications truthful states and row feedback", () => {
  it("omits unknown counts during loading and uses inline status", () => {
    const html = renderToString(page(client()));
    expect(html).toContain("Loading notifications");
    expect(html).not.toContain("All (0)");
    expect(html).not.toContain("Unread (0)");
    expect(html).not.toContain("jds-empty");
    expect(html).not.toContain("tk-toolbar");
  });
  it("offers retry when loading fails", () => {
    const queryClient = client();
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: queryKeys.notifications.list })
      .setState({ status: "error", error: new Error("Read failed"), fetchStatus: "idle" });
    const html = renderToString(page(queryClient));
    expect(html).toContain("Could not load notifications");
    expect(html).toContain("Try again");
    expect(html).not.toContain("No notifications");
  });
  it("distinguishes an empty unread filter", async () => {
    const queryClient = client();
    queryClient.setQueryData(queryKeys.notifications.list, {
      notifications: [{ ...notification("1"), readAt: "2026-10-10T13:00:00Z" }],
      unreadCount: 0
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(page(queryClient));
    });
    const unread = renderer.root
      .findAllByType("button")
      .find((node) => node.props.children === "Unread (0)")!;
    await act(async () => unread.props.onClick());
    expect(JSON.stringify(renderer.toJSON())).toContain("No unread notifications");
    await act(async () => renderer.unmount());
    queryClient.clear();
  });
  it("identifies only the pending row, then reports its failed mark-read request", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
    );
    const queryClient = client();
    queryClient.setQueryData(queryKeys.notifications.list, {
      notifications: [notification("1"), notification("2")],
      unreadCount: 2
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(page(queryClient));
    });
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((node) => node.props["aria-label"] === "Mark Notice 1 read")!
        .props.onClick();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const rows = renderer.root.findAllByType("article");
    expect(rows.map((row) => row.props["aria-busy"])).toEqual([true, false]);
    await act(async () => {
      finish(new Response("", { status: 503 }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Could not mark this notification read");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});

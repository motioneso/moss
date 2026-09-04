import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import type { MeResponse, ModuleDto } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined
} as unknown as Storage);

vi.mock("../../apps/web/src/chat/use-chat-stream.js", () => ({
  useChatStream: () => ({
    records: [],
    clearRecords: vi.fn(),
    streamErrorCount: 0
  })
}));

vi.mock("../../apps/web/src/chat/chat-drawer.js", () => ({
  ChatDrawer: () => null
}));

const { AppShell } = await import("../../apps/web/src/shell/app-shell.js");

const ME: MeResponse = {
  user: {
    id: "user-1",
    email: "ben@example.com",
    emailVerified: true,
    name: "Ben",
    isInstanceAdmin: false,
    status: "active",
    isBootstrapOwner: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

const MODULES: readonly ModuleDto[] = [];

function renderShellWithUnread(unreadCount: number): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.notifications.list, {
    notifications: [],
    unreadCount,
    unreadByModule: {}
  });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/today"] },
        createElement(AppShell, {
          me: ME,
          modules: MODULES,
          modulesLoading: false,
          children: createElement("div", null, "content")
        })
      )
    )
  );
}

describe("RailUserMenu notification badge", () => {
  it("renders the unread notification badge on the closed user menu when unreadCount > 0", () => {
    const html = renderShellWithUnread(11);
    expect(html).toContain('class="jds-usermenu__trigger "');
    expect(html).toContain('<span class="jds-badge-count">11</span>');
  });

  it("hides the unread notification badge on the closed user menu when unreadCount is 0", () => {
    const html = renderShellWithUnread(0);
    expect(html).toContain('class="jds-usermenu__trigger "');
    expect(html).not.toContain('<span class="jds-badge-count"');
  });

  it("caps large unread counts at 99+", () => {
    const html = renderShellWithUnread(120);
    expect(html).toContain('<span class="jds-badge-count">99+</span>');
  });
});

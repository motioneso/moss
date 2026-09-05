import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import type { MeResponse, ModuleDto } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { hasModuleSettings, resolveActiveModuleId } from "../../apps/web/src/shell/app-shell.js";
import { moduleSettingsHref } from "../../apps/web/src/settings/module-settings-deep-link.js";

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
    isInstanceAdmin: true,
    status: "active",
    isBootstrapOwner: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

const MODULES: readonly ModuleDto[] = [
  {
    id: "news",
    name: "News",
    version: "1.0.0",
    lifecycle: "optional",
    navigation: [{ id: "news", label: "News", path: "/news", icon: "newspaper", order: 34 }],
    settings: [
      { id: "news.prefs", label: "News", path: "/settings/modules/news", scope: "user", order: 34 }
    ]
  },
  {
    id: "sports",
    name: "Sports",
    version: "1.0.0",
    lifecycle: "optional",
    navigation: [{ id: "sports", label: "Sports", path: "/sports", icon: "trophy", order: 35 }],
    settings: [
      {
        id: "sports.follows",
        label: "Sports",
        path: "/settings/modules/sports",
        scope: "user",
        order: 35
      }
    ]
  },
  {
    id: "tasks",
    name: "Tasks",
    version: "1.0.0",
    lifecycle: "optional",
    navigation: [{ id: "tasks", label: "Tasks", path: "/tasks", icon: "list", order: 30 }],
    settings: [
      {
        id: "tasks.settings",
        label: "Tasks",
        path: "/settings/modules/tasks",
        scope: "user",
        order: 30
      }
    ]
  },
  {
    id: "calendar",
    name: "Calendar",
    version: "1.0.0",
    lifecycle: "optional",
    navigation: [
      { id: "calendar", label: "Calendar", path: "/calendar", icon: "calendar", order: 31 }
    ],
    settings: [
      {
        id: "calendar.settings",
        label: "Calendar",
        path: "/settings/modules/calendar",
        scope: "user",
        order: 31
      }
    ]
  },
  {
    id: "wellness",
    name: "Wellness",
    version: "1.0.0",
    lifecycle: "optional",
    navigation: [
      { id: "wellness", label: "Wellness", path: "/wellness", icon: "heart", order: 32 }
    ],
    settings: [
      {
        id: "wellness.settings",
        label: "Wellness",
        path: "/settings/modules/wellness",
        scope: "user",
        order: 32
      }
    ]
  },
  {
    id: "workshop",
    name: "Workshop",
    version: "1.0.0",
    lifecycle: "optional",
    navigation: [
      { id: "workshop", label: "Workshop", path: "/workshop", icon: "wrench", order: 50 }
    ],
    settings: []
  }
];

function renderShell(path: string): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.notifications.list, {
    notifications: [],
    unreadCount: 0,
    unreadByModule: {}
  });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
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

describe("AppShell module settings button in topbar", () => {
  it("resolves module settings href accurately", () => {
    expect(moduleSettingsHref("news")).toBe("/settings?section=modules&module=news");
    expect(moduleSettingsHref("sports")).toBe("/settings?section=modules&module=sports");
  });

  it("identifies which modules have settings surfaces", () => {
    expect(hasModuleSettings("news", MODULES)).toBe(true);
    expect(hasModuleSettings("sports", MODULES)).toBe(true);
    expect(hasModuleSettings("tasks", MODULES)).toBe(true);
    expect(hasModuleSettings("calendar", MODULES)).toBe(true);
    expect(hasModuleSettings("wellness", MODULES)).toBe(true);
    expect(hasModuleSettings("workshop", MODULES)).toBe(false);
  });

  it("resolves active module id from pathname", () => {
    expect(resolveActiveModuleId("/news")).toBe("news");
    expect(resolveActiveModuleId("/sports")).toBe("sports");
    expect(resolveActiveModuleId("/tasks")).toBe("tasks");
    expect(resolveActiveModuleId("/calendar")).toBe("calendar");
    expect(resolveActiveModuleId("/wellness")).toBe("wellness");
    expect(resolveActiveModuleId("/today")).toBeNull();
    expect(resolveActiveModuleId("/notifications")).toBeNull();
    expect(resolveActiveModuleId("/settings")).toBeNull();
    expect(resolveActiveModuleId("/m/custom-mod/subpage")).toBe("custom-mod");
  });

  it("renders the settings cogwheel next to section name on News page", () => {
    const html = renderShell("/news");
    expect(html).toContain('class="topbar-title-row"');
    expect(html).toContain('aria-label="News settings"');
    expect(html).toContain('href="/settings?section=modules&amp;module=news"');
  });

  it("renders the settings cogwheel next to section name on Sports page", () => {
    const html = renderShell("/sports");
    expect(html).toContain('class="topbar-title-row"');
    expect(html).toContain('aria-label="Sports settings"');
    expect(html).toContain('href="/settings?section=modules&amp;module=sports"');
  });

  it("renders the settings cogwheel next to section name on Tasks page", () => {
    const html = renderShell("/tasks");
    expect(html).toContain('class="topbar-title-row"');
    expect(html).toContain('aria-label="Tasks settings"');
    expect(html).toContain('href="/settings?section=modules&amp;module=tasks"');
  });

  it("does not render the settings cogwheel on Today, but does on every module page", () => {
    const todayHtml = renderShell("/today");
    expect(todayHtml).not.toContain('class="topbar-settings-button');

    // An external module that declares no settings still gets the gear, linking to its
    // settings page (Ben, 2026-09-04: every module page, even optional or external ones).
    const externalHtml = renderShell("/m/weather");
    expect(externalHtml).toContain('href="/settings?section=modules&amp;module=weather"');
  });
});

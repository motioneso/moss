// @vitest-environment jsdom
// Regression coverage for PR 2220: Chat settings' "Set up" button targets the admin-only
// aiproviders section while the settings page is showing personal sections. The old
// section switcher checked the requested id only against whichever list (personal or admin)
// the page was already showing, so from personal settings it silently fell back to the first
// personal section instead of switching into admin mode.
//
// This renders Chat's real settings screen, with its real "Set up" button, wired into the real
// settings page exactly the way the app wires it (settings-personal-data-panes.tsx passes the
// page's own section-switch handler straight through as that screen's onCat prop). Only the
// screen that lists all the other modules is stood in for, so the test does not also have to
// fake every module's data; the button under test is never touched. This way, restoring the old,
// broken section-switching code makes the click miss its target and the test catches it, instead
// of a stand-in button papering over the bug.
// Same jsdom + react-test-renderer pattern as tests/unit/settings-ai-admin-pane.test.tsx (this
// repo has no @testing-library/react).
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { PaneProps } from "../../apps/web/src/settings/settings-types.js";
import type * as ClientModule from "../../apps/web/src/api/client.js";

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss"
}));

vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>();
  return {
    ...actual,
    getChatSettings: vi.fn(async () => ({ chat: { responseStyle: "balanced" } })),
    putChatSettings: vi.fn(),
    lookupAiCapabilityRoute: vi.fn(async () => ({ route: null }))
  };
});

// The screen that lists every module is not what this test is about (the bug and the fix are
// both in how settings-page.tsx picks which section to show once asked, not in how the module
// list gets to Chat's screen), so it is stood in with a minimal replacement that goes straight to
// Chat's real screen. That screen, and its "Set up" button, are the genuine article — not a
// stand-in — wired up with the same handler the real module list passes it.
vi.mock("../../apps/web/src/settings/settings-personal-data-panes.js", () => ({
  ModulesPane: ({ onSelectSection }: PaneProps) =>
    createElement(ChatSettingsView, { onBack: () => {}, onCat: onSelectSection })
}));

// The destination screen is not what this test is about (the bug and the fix are both in how
// settings-page.tsx picks which section to show, not in what the admin AI section renders), so
// stub it out to keep the test to the one thing it is checking.
vi.mock("../../apps/web/src/settings/settings-ai-admin-pane.js", () => ({
  AiProvidersPane: () => createElement("div", null, "AI providers pane")
}));

import { ChatSettingsView } from "../../apps/web/src/settings/settings-module-subviews.js";
import { SettingsPage } from "../../apps/web/src/settings/settings-page.js";

const nonAdminMe = {
  user: {
    id: "user-1",
    email: "user@example.test",
    emailVerified: true,
    name: "User",
    status: "active" as const,
    isInstanceAdmin: false,
    isBootstrapOwner: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: false
};
const adminMe = {
  user: {
    id: "admin-1",
    email: "admin@example.test",
    emailVerified: true,
    name: "Admin",
    status: "active" as const,
    isInstanceAdmin: true,
    isBootstrapOwner: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function renderModulesFor(
  me: typeof nonAdminMe | typeof adminMe
): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ["/settings?section=modules"] },
          createElement(SettingsPage, { me })
        )
      )
    );
  });
  await flush();
  return renderer;
}

function clickButtonByText(renderer: ReactTestRenderer, text: string): void {
  const button = renderer.root
    .findAllByType("button")
    .find((instance) => instance.children.includes(text));
  if (!button) throw new Error(`button "${text}" not found`);
  act(() => {
    (button.props.onClick as () => void)();
  });
}

function pageText(renderer: ReactTestRenderer): string {
  function collect(node: unknown): string {
    if (node == null) return "";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(collect).join(" ");
    if (typeof node === "object" && "children" in (node as Record<string, unknown>)) {
      return collect((node as { children: unknown }).children);
    }
    return "";
  }
  return collect(renderer.toJSON());
}

describe("settings setup link crosses from personal to admin sections (PR 2220)", () => {
  it("takes an admin from Chat's real Set up button in personal settings to the admin AI section", async () => {
    const renderer = await renderModulesFor(adminMe);
    await flush();

    clickButtonByText(renderer, "Set up");
    await flush();

    const text = pageText(renderer);

    // The admin-only note and admin group labels only render once the page has switched into
    // admin mode. The old code stayed in personal mode and silently landed on the first
    // personal section (Account & preferences) instead.
    expect(text).toContain("You have owner access");
    expect(text).toContain("AI & extensions");
    expect(text).not.toContain("Account & preferences");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not let an ordinary user land on the admin section from the same real button", async () => {
    const renderer = await renderModulesFor(nonAdminMe);
    await flush();

    clickButtonByText(renderer, "Set up");
    await flush();

    const text = pageText(renderer);

    expect(text).not.toContain("You have owner access");
    expect(text).not.toContain("AI & extensions");

    await act(async () => {
      renderer.unmount();
    });
  });
});

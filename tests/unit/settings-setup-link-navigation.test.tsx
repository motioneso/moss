// @vitest-environment jsdom
// Regression coverage for PR 2220: a button in personal settings that jumps to the admin-only
// AI providers section needs to work even while the settings page is showing personal sections.
// The old section switcher checked the requested id only against whichever list (personal or
// admin) the page was already showing, so from personal settings it silently fell back to the
// first personal section instead of switching into admin mode.
//
// The real button this bug was about (Chat settings' old "Set up" link) was removed from the
// app on 2026-09-04 when Chat's settings were folded into the combined Assistant and AI screen,
// which has no equivalent button. So this test stands in a plain button for the button that used
// to be there, wired to the exact same handler the real screens use to jump sections
// (onSelectSection, passed straight through by settings-page.tsx). What is still exercised for
// real, and is still the actual point of this test, is settings-page.tsx's own section-switching
// logic, and the real admin destination screen it lands on.
// Same jsdom + react-test-renderer pattern as tests/unit/settings-ai-admin-pane.test.tsx (this
// repo has no @testing-library/react).
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
    lookupAiCapabilityRoute: vi.fn(async () => ({ route: null })),
    listAiProviders: vi.fn(async () => ({ providers: [] })),
    listAiModels: vi.fn(async () => ({ models: [] })),
    listAiServiceBindings: vi.fn(async () => ({ bindings: [] })),
    getChatModelOverrideSettings: vi.fn(async () => ({ settings: { overrideEnabled: false } }))
  };
});

// The screen that lists every module is not what this test is about (the bug and the fix are
// both in how settings-page.tsx picks which section to show once asked, not in how a module's
// screen gets its jump-to-admin button), so it is stood in with a minimal replacement: a plain
// button that calls the same section-switch handler the real module list would pass through.
// There is no real button left to render in its place (see the comment at the top of this file),
// so this stand-in is doing the job the old Chat settings "Set up" button used to do.
vi.mock("../../apps/web/src/settings/settings-personal-data-panes.js", () => ({
  ModulesPane: ({ onSelectSection }: PaneProps) =>
    createElement(
      "button",
      { onClick: () => onSelectSection?.("aiproviders") },
      "Set up"
    )
}));

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

// The settings page loads each screen on demand, so the destination screen's code is only
// fetched the moment the button is pressed. Loading it for the first time takes seconds here,
// far longer than a test is willing to wait, so warm it up once before any test runs; after that
// the page gets it immediately, exactly as a real browser does on a second visit.
beforeAll(async () => {
  await import("../../apps/web/src/settings/settings-ai-admin-pane.js");
});

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

function nodeText(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map(nodeText).join(" ");
}

function buttonsWithText(renderer: ReactTestRenderer, text: string): ReactTestInstance[] {
  return renderer.root
    .findAllByType("button")
    .filter((instance) => nodeText(instance).includes(text));
}

function clickButtonByText(renderer: ReactTestRenderer, text: string): void {
  const button = buttonsWithText(renderer, text)[0];
  if (!button) throw new Error(`button "${text}" not found`);
  act(() => {
    (button.props.onClick as () => void)();
  });
}

// The heading each settings screen draws for itself, which is what tells us the page really
// arrived at that screen. The list of categories down the side repeats some of the same words,
// so reading the whole page would not distinguish "the link landed here" from "the link is
// listed here".
function paneHeadings(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((instance) => instance.type === "h2" && instance.props.className === "pane__title", {
      deep: true
    })
    .map((instance) => nodeText(instance).trim());
}

function paneText(renderer: ReactTestRenderer): string {
  const panes = renderer.root.findAll(
    (instance) => typeof instance.type === "string" && instance.props.className === "set2__pane",
    { deep: true }
  );
  return panes.map(nodeText).join(" ");
}

describe("settings setup link crosses from personal to admin sections (PR 2220)", () => {
  it("takes an admin from Chat's real Set up button in personal settings to the admin AI section", async () => {
    const renderer = await renderModulesFor(adminMe);
    await flush();

    clickButtonByText(renderer, "Set up");
    await flush();
    await flush();

    // The destination screen really drew itself: its own heading, and its own controls.
    expect(paneHeadings(renderer)).toEqual(["Assistant & AI"]);
    expect(paneText(renderer)).toContain("The AI providers this instance runs on");
    expect(buttonsWithText(renderer, "Add provider").length).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ ariaLabel: "Allow users to override their chat model" }).length
    ).toBeGreaterThan(0);

    // And the screen the old, broken code fell back to is not the one on show.
    expect(paneHeadings(renderer)).not.toContain("Account & preferences");

    // The admin-only note and admin group labels only render once the page has switched into
    // admin mode.
    const text = paneText(renderer);
    expect(text).not.toContain("Account & preferences");
    expect(
      renderer.root
        .findAll(
          (instance) =>
            typeof instance.type === "string" && instance.props.className === "set2__navnote",
          { deep: true }
        )
        .map(nodeText)
        .join(" ")
    ).toContain("You have owner access");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not let an ordinary user land on the admin section from the same real button", async () => {
    const renderer = await renderModulesFor(nonAdminMe);
    await flush();

    clickButtonByText(renderer, "Set up");
    await flush();
    await flush();

    // The ordinary user stays in personal settings: the admin screen's heading and controls are
    // nowhere on the page, and the page never claims owner access.
    expect(paneHeadings(renderer)).toEqual(["Account & preferences"]);
    expect(paneText(renderer)).not.toContain("The AI providers this instance runs on");
    expect(buttonsWithText(renderer, "Add provider")).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ ariaLabel: "Allow users to override their chat model" })
    ).toHaveLength(0);
    expect(nodeText(renderer.root)).not.toContain("You have owner access");

    await act(async () => {
      renderer.unmount();
    });
  });
});

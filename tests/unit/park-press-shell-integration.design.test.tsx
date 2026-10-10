// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse } from "@moss/shared";

// Keep the real host, navigation and shared keyboard lifecycle. Unrelated chat,
// command palette and module controls are boundary doubles, not a live-path proof.
vi.mock("../../apps/web/src/chat/chat-drawer.js", () => ({ ChatDrawer: () => null }));
vi.mock("../../apps/web/src/chat/meeting-chat-drawer.js", () => ({
  MeetingChatDrawer: () => null
}));
vi.mock("../../apps/web/src/chat/use-page-context-sync.js", () => ({
  usePageContextSync: () => {}
}));
vi.mock("../../apps/web/src/chat/use-chat-stream.js", () => ({
  useChatStream: () => ({ records: [], clearRecords: vi.fn(), streamErrorCount: 0 })
}));
vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss",
  assistantName: () => "Moss"
}));
vi.mock("../../apps/web/src/shell/command-palette.js", () => ({ CommandPalette: () => null }));
vi.mock("../../apps/web/src/shell/module-persistent-controls.js", () => ({
  ModulePersistentControls: () => null
}));

import { AppShell } from "../../apps/web/src/shell/app-shell.js";

const me: MeResponse = {
  user: {
    id: "navigation-fixture",
    email: "navigation@example.com",
    emailVerified: true,
    name: "Navigation fixture",
    isInstanceAdmin: false,
    status: "active",
    isBootstrapOwner: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let mobileMedia: { matches: boolean };
let mediaListeners: Set<() => void>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mobileMedia = { matches: true };
  mediaListeners = new Set();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("max-width") && mobileMedia.matches;
    },
    media: query,
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener)
  }));
  client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, gcTime: 0 } }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

function LocationProbe() {
  return <output data-location>{useLocation().pathname}</output>;
}

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/today"]}>
          <AppShell me={me} modules={[]} modulesLoading={false}>
            <button type="button">Page action</button>
            <LocationProbe />
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
}

function openButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]');
  if (!button) throw new Error("Missing real navigation trigger");
  return button;
}

describe("Park Press shell and shared navigation integration", () => {
  it("connects the host trigger to the real navigation and reflects open state", async () => {
    await mount();
    const trigger = openButton();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe("moss-main-navigation");
    const navigation = document.getElementById(trigger.getAttribute("aria-controls")!);
    expect(navigation).not.toBeNull();
    trigger.focus();
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(navigation?.getAttribute("role")).toBe("dialog");
    expect(navigation?.getAttribute("aria-modal")).toBe("true");
    expect(navigation?.contains(document.activeElement)).toBe(true);
  });

  it.each(["escape", "close", "scrim"] as const)(
    "%s dismisses navigation, clears modal state and returns focus to its host trigger",
    async (dismissal) => {
      await mount();
      const trigger = openButton();
      trigger.focus();
      await act(async () => trigger.click());
      const navigation = document.getElementById("moss-main-navigation");
      await act(async () => {
        if (dismissal === "escape") {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          );
        } else if (dismissal === "scrim") {
          const scrim = container.querySelector<HTMLElement>(".sidebar-scrim");
          if (!scrim) throw new Error("Missing pointer-dismissal scrim");
          scrim.click();
        } else {
          const close = navigation?.querySelector<HTMLButtonElement>(
            '[aria-label="Close navigation"]'
          );
          if (!close) throw new Error("Missing navigation close control");
          close.click();
        }
      });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(navigation?.getAttribute("aria-modal")).not.toBe("true");
      expect(document.activeElement).toBe(trigger);
      expect(container.querySelector(".workspace-area")?.hasAttribute("inert")).toBe(false);
      await act(async () => trigger.click());
      expect(navigation?.contains(document.activeElement)).toBe(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    }
  );

  it("releases mobile isolation and modal semantics when returning to desktop", async () => {
    await mount();
    const persistentHostListeners = mediaListeners.size;
    const trigger = openButton();
    trigger.focus();
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      mobileMedia.matches = false;
      for (const listener of mediaListeners) listener();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const navigation = document.getElementById("moss-main-navigation");
    expect(navigation?.getAttribute("role")).toBeNull();
    expect(navigation?.getAttribute("aria-modal")).toBeNull();
    expect(container.querySelector(".workspace-area")?.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(mediaListeners.size).toBe(persistentHostListeners);
  });

  it("closes the mobile account menu on navigation and returns focus to the visible host trigger", async () => {
    await mount();
    const trigger = openButton();
    trigger.focus();
    await act(async () => trigger.click());
    const account = container.querySelector<HTMLButtonElement>('[aria-label="Account menu"]');
    expect(account).not.toBeNull();
    await act(async () => account!.click());
    const settings = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Settings")
    );
    expect(settings).toBeDefined();
    await act(async () => settings!.click());
    expect(container.querySelector("[data-location]")?.textContent).toBe("/settings");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

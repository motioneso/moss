// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocaleSettingsDto, ScheduleSlotDto } from "@moss/shared";
import { localDay } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { TodayQuickActions } from "../../apps/web/src/today/today-quick-actions.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

function slots(): ScheduleSlotDto[] {
  return [
    {
      medicationId: "m1",
      name: "Morning pill",
      scheduledFor: null,
      asNeeded: false,
      status: "taken"
    },
    {
      medicationId: "m2",
      name: "Evening pill",
      scheduledFor: null,
      asNeeded: false,
      status: "pending"
    }
  ];
}

function pendingSlots(): ScheduleSlotDto[] {
  return slots().map((slot) => ({ ...slot, status: "pending" as const }));
}

function seedClient(slotSource: () => ScheduleSlotDto[] = slots): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  client.setQueryData(queryKeys.settings.locale, { locale });
  client.setQueryData(queryKeys.wellness.schedule(localDay(new Date(), locale.timezone)), {
    date: localDay(new Date(), locale.timezone),
    slots: slotSource()
  });
  return client;
}

function renderDock(
  client: QueryClient,
  enabled = true
): { renderer: ReactTestRenderer; root: ReactTestInstance } {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TodayQuickActions, {
          enabled,
          theme: "light",
          timeZone: locale.timezone,
          disabledModuleIds: ["news", "sports", "workshop"]
        })
      )
    );
  });
  if (!renderer) throw new Error("dock did not render");
  return { renderer, root: renderer.root };
}

function textOf(node: ReactTestInstance): string {
  const out: string[] = [];
  const walk = (child: ReactTestInstance | string): void => {
    if (typeof child === "string") {
      out.push(child);
      return;
    }
    for (const grandchild of child.children) walk(grandchild);
  };
  walk(node);
  return out.join(" ").replace(/\s+/g, " ");
}

function buttonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const found = root.findAllByType("button").find((button) => textOf(button).includes(text));
  if (!found) throw new Error(`button with text "${text}" not found`);
  return found;
}

// Real-DOM mounting for the keyboard contract: the opener must be a live
// element so focus return is observable through document.activeElement.
async function mountDom(slotSource: () => ScheduleSlotDto[] = slots): Promise<{
  opener: () => HTMLButtonElement;
  dialog: () => HTMLElement | null;
  unmount: () => Promise<void>;
}> {
  const { createRoot } = await import("react-dom/client");
  const { act: domAct } = await import("react");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = seedClient(slotSource);
  await domAct(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TodayQuickActions, {
          enabled: true,
          theme: "light",
          timeZone: locale.timezone,
          disabledModuleIds: ["news", "sports", "workshop"]
        })
      )
    );
  });
  return {
    opener: () => {
      const found = container.querySelector('button[aria-label="Log medication"]');
      if (!found) throw new Error('opener button "Log medication" not found');
      return found as HTMLButtonElement;
    },
    dialog: () => container.querySelector('[role="dialog"]'),
    unmount: async () => {
      await domAct(async () => {
        root.unmount();
      });
      container.remove();
    }
  };
}

describe("TodayQuickActions", () => {
  it("reads the mockup count line with none logged", async () => {
    const { opener, unmount } = await mountDom(pendingSlots);
    try {
      expect(document.body.textContent ?? "").toContain("0 of 2 logged");
      expect(opener().textContent).toBe("+");
    } finally {
      await unmount();
    }
  });

  it("closes the Meds dialog on Escape and returns focus to the opener", async () => {
    const { act: domAct } = await import("react");
    const { opener, dialog, unmount } = await mountDom(pendingSlots);
    try {
      await domAct(async () => {
        opener().click();
      });
      expect(dialog()).not.toBeNull();
      await domAct(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(opener());
    } finally {
      await unmount();
    }
  });

  it("returns focus to the opener after Done and after X", async () => {
    const { act: domAct } = await import("react");
    for (const closer of ["Done", "Close"] as const) {
      const { opener, dialog, unmount } = await mountDom(pendingSlots);
      try {
        await domAct(async () => {
          opener().click();
        });
        expect(dialog()).not.toBeNull();
        const closeButton = [...dialog()!.querySelectorAll("button")].find(
          (button) =>
            button.textContent === closer ||
            (closer === "Close" && button.getAttribute("aria-label") === "Close")
        );
        if (!closeButton) throw new Error(`${closer} control not found in dialog`);
        await domAct(async () => {
          (closeButton as HTMLButtonElement).click();
        });
        expect(dialog()).toBeNull();
        expect(document.activeElement).toBe(opener());
      } finally {
        await unmount();
      }
    }
  });

  it("renders the Wellness block with counts and both buttons", () => {
    const client = seedClient();
    const { renderer, root } = renderDock(client);
    try {
      expect(textOf(root)).toContain("Quick actions");
      expect(textOf(root)).toContain("Wellness");
      expect(textOf(root)).toContain("Medications");
      expect(textOf(root)).toContain("1 of 2 logged");
      expect(textOf(root)).toContain("+");
      expect(root.findByProps({ "aria-label": "Log medication" })).toBeDefined();
      expect(textOf(root)).toContain("Check in with yourself");
      expect(textOf(root)).toContain("A moment to notice how you are.");
      expect(textOf(root)).toContain("Check in");
    } finally {
      renderer.unmount();
    }
  });

  it("opens the Medications dialog from the plus control", () => {
    const client = seedClient();
    const { renderer, root } = renderDock(client);
    try {
      act(() => {
        root.findByProps({ "aria-label": "Log medication" }).props.onClick({ currentTarget: null });
      });
      expect(root.findByProps({ id: "today-meds-title" })).toBeDefined();
      expect(textOf(root)).toContain("Medications");
    } finally {
      renderer.unmount();
    }
  });

  it("saves a check-in and invalidates checkins and insights", async () => {
    const seen: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      seen.push(String(url));
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    });
    const client = seedClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { renderer, root } = renderDock(client);
    try {
      act(() => {
        buttonByText(root, "Check in").props.onClick();
      });
      expect(textOf(root)).toContain("How are you feeling right now?");
      const input = root.findByProps({ className: "wl-search__input" });
      act(() => {
        input.props.onFocus();
        input.props.onChange({ target: { value: "a" } });
      });
      const results = root.findAllByProps({ className: "wl-search__item" });
      expect(results.length).toBeGreaterThan(0);
      const feeling =
        results.find((item) => {
          try {
            item.findByProps({ className: "wl-search__label" });
            return true;
          } catch {
            return false;
          }
        }) ?? results[0];
      if (!feeling) throw new Error("no search result to pick");
      const pickedFeeling = feeling.findAllByProps({ className: "wl-search__label" }).length > 0;
      act(() => {
        feeling?.props.onClick();
      });
      if (!pickedFeeling) {
        const chips = root.findAll(
          (node) =>
            typeof node.props?.className === "string" && node.props.className.startsWith("wl-fchip")
        );
        expect(chips.length).toBeGreaterThan(0);
        act(() => {
          chips[0]?.props.onClick();
        });
      }
      await act(async () => {
        buttonByText(root, "Save check-in").props.onClick();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.wellness.checkins });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.wellness.insights });
    } finally {
      fetchSpy.mockRestore();
      invalidateSpy.mockRestore();
      renderer.unmount();
    }
  });

  it("renders nothing wellness when disabled", () => {
    const client = seedClient();
    const { renderer, root } = renderDock(client, false);
    try {
      expect(textOf(root)).not.toContain("Wellness");
      expect(textOf(root)).not.toContain("Meds");
      expect(textOf(root)).not.toContain("Check in");
    } finally {
      renderer.unmount();
    }
  });
});

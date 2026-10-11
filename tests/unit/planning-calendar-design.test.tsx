// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventDto } from "@moss/shared";
import { CalendarPage } from "../../apps/web/src/calendar/calendar-page.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
const api = vi.hoisted(() => ({ listCalendarEvents: vi.fn() }));
vi.mock("../../apps/web/src/api/client.js", () => api);
vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({ useAssistantName: () => "Moss" }));
const event: CalendarEventDto = {
  id: "calendar-design",
  connectorAccountId: "connector-design",
  ownerUserId: "owner-design",
  title: "Planning with the team",
  startsAt: "2026-09-10T10:00:00Z",
  endsAt: "2026-09-10T11:00:00Z",
  location: "Planning room",
  summary: null,
  bodyExcerpt: null,
  externalId: "external-design",
  isMossBlock: false,
  allDay: false,
  attendeeCount: 2,
  status: "accepted",
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z"
};
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("moss.cal.cursor", "2026-09-10T00:00:00Z");
  localStorage.setItem("moss.cal.view", "week");
  api.listCalendarEvents.mockReset().mockResolvedValue({ events: [event] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CalendarPage />
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
}
async function eventually(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    check();
  });
}
function button(name: string) {
  const node = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === name || item.getAttribute("aria-label") === name
  );
  if (!node) throw new Error(`Missing button ${name}`);
  return node;
}
describe("calendar responsive and recovery contracts", () => {
  it("keeps the toolbar while loading and exposes a quiet status", async () => {
    api.listCalendarEvents.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(button("Today")).toBeDefined();
    expect(button("Week").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading calendar…");
    expect(container.querySelector(".spin")).toBeNull();
  });
  it("offers retry on initial failure without discarding the chosen view", async () => {
    api.listCalendarEvents.mockRejectedValueOnce(new Error("Unavailable"));
    await render();
    await eventually(() => expect(container.textContent).toContain("Could not load your calendar"));
    expect(button("Week").getAttribute("aria-pressed")).toBe("true");
    act(() => button("Retry").click());
    await eventually(() => expect(container.textContent).toContain(event.title));
  });
  it("retains loaded events on refresh failure and recovers in place", async () => {
    await render();
    await eventually(() => expect(container.textContent).toContain(event.title));
    api.listCalendarEvents.mockRejectedValueOnce(new Error("Unavailable"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.calendar.list });
    });
    await eventually(() =>
      expect(container.textContent).toContain("Could not refresh your calendar")
    );
    expect(container.textContent).toContain(event.title);
    act(() => button("Retry").click());
    await eventually(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  });
  it("keeps explicit Day, Week and Month selection and makes dense views keyboard-scrollable regions", async () => {
    await render();
    await eventually(() => expect(container.textContent).toContain(event.title));
    const region = () => container.querySelector<HTMLElement>('.cal-body[role="region"]')!;
    expect(region().tabIndex).toBe(0);
    expect(region().getAttribute("aria-describedby")).toBe("calendar-scroll-hint");
    act(() => button("Month").click());
    expect(localStorage.getItem("moss.cal.view")).toBe("month");
    expect(region().getAttribute("aria-label")).toBe("Calendar month");
    expect(container.querySelector<HTMLElement>(".cal-month")?.style.minWidth).toBe("1008px");
    act(() => button("Day").click());
    expect(localStorage.getItem("moss.cal.view")).toBe("day");
    expect(region().hasAttribute("tabindex")).toBe(false);
    expect(container.querySelector<HTMLElement>(".cal-tg")?.style.minWidth).toBe("0px");
  });
  it("opens the shared modal peek and restores focus after Escape", async () => {
    await render();
    await eventually(() => expect(container.textContent).toContain(event.title));
    const opener = container.querySelector<HTMLButtonElement>(".cal-ev")!;
    act(() => {
      opener.focus();
      opener.click();
    });
    await eventually(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      )
    );
    await eventually(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

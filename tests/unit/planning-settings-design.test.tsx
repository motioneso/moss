// @vitest-environment jsdom
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TasksSettings from "../../packages/tasks/src/settings/index.js";
import CalendarSettings from "../../packages/calendar/src/settings/index.js";

const taskPath = "/api/tasks/agency-auto-execute";
const calendarPath = "/api/calendar/briefing-settings";
const sourcePath = "/api/me/source-behaviors";
const payloads: Record<string, unknown> = {
  [taskPath]: { enabled: true },
  [calendarPath]: { settings: { lookaheadDays: 2, prepTaskMode: "auto", timeBlockMode: "off" } },
  [sourcePath]: { sources: [{ behaviors: [{ id: "calendar.briefings", enabled: true }] }] }
};
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let readsFail: boolean;
let writesFail: boolean;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  readsFail = false;
  writesFail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method && init.method !== "GET") {
        if (writesFail) return response({}, 503);
        return response(path === taskPath ? { enabled: false } : payloads[path]);
      }
      return readsFail ? response({}, 503) : response(payloads[path]);
    })
  );
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function render(Component: ComponentType) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Component />
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
function retry() {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Retry loading"
  );
  if (!button) throw new Error("Missing load retry");
  act(() => button.click());
}
function switches() {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

for (const [name, Component, prefix] of [
  ["Tasks", TasksSettings, "task"],
  ["Calendar", CalendarSettings, "calendar"]
] as const) {
  describe(`${name} truthful settings states`, () => {
    it("announces loading and keeps unknown settings disabled", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(() => undefined))
      );
      await render(Component);
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        `Loading ${prefix} settings…`
      );
      expect(switches().every((control) => control.disabled)).toBe(true);
    });
    it("distinguishes initial load failure from save failure and retries loading", async () => {
      readsFail = true;
      await render(Component);
      await eventually(() =>
        expect(container.textContent).toContain(`Could not load ${prefix} settings`)
      );
      expect(container.textContent).not.toContain("Could not save");
      expect(switches().every((control) => control.disabled)).toBe(true);
      readsFail = false;
      retry();
      await eventually(() => expect(switches().every((control) => !control.disabled)).toBe(true));
      expect(switches()[0]?.checked).toBe(true);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
    it("retains known values on a failed refresh and offers load recovery", async () => {
      await render(Component);
      await eventually(() => expect(switches()[0]?.disabled).toBe(false));
      readsFail = true;
      await act(async () => {
        await client.invalidateQueries();
      });
      await eventually(() =>
        expect(container.textContent).toContain(`Could not refresh ${prefix} settings`)
      );
      expect(switches()[0]?.checked).toBe(true);
      expect(container.textContent).not.toContain("Could not save");
      readsFail = false;
      retry();
      await eventually(() => expect(container.querySelector('[role="alert"]')).toBeNull());
    });
    it("reports failed persistence separately and retains the saved value", async () => {
      await render(Component);
      await eventually(() => expect(switches()[0]?.disabled).toBe(false));
      writesFail = true;
      act(() => switches()[0]!.click());
      await eventually(() => expect(container.textContent).toContain("Could not save"));
      expect(switches()[0]?.checked).toBe(true);
      expect(container.textContent).not.toContain(`Could not load ${prefix} settings`);
    });
  });
}

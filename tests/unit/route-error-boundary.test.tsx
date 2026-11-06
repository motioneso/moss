// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadWithRetry } from "../../apps/web/src/shell/lazy-with-retry.js";
import { RouteErrorBoundary } from "../../apps/web/src/shell/route-error-boundary.js";

function BrokenPage(): never {
  throw new Error("Failed to fetch dynamically imported module");
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function mount(children: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(children));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.replaceChildren();
  root = undefined;
});

describe("RouteErrorBoundary", () => {
  it("renders the page when nothing goes wrong", () => {
    mount(
      createElement(
        RouteErrorBoundary,
        { resetKey: "/today" },
        createElement("p", null, "Today page")
      )
    );
    expect(host?.textContent).toContain("Today page");
    expect(host?.textContent).not.toContain("This page could not be loaded");
  });

  it("shows a page-only error with a reload offer when a page fails to load", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mount(
        createElement(
          RouteErrorBoundary,
          { resetKey: "/today" },
          createElement(
            "div",
            null,
            createElement(BrokenPage),
            createElement("p", null, "Today page")
          )
        )
      );
      expect(host?.textContent).toContain("This page could not be loaded");
      expect(host?.textContent).toContain("Reload page");
      expect(host?.textContent).not.toContain("Today page");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("clears the error when the person moves to another page", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mount(createElement(RouteErrorBoundary, { resetKey: "/today" }, createElement(BrokenPage)));
      expect(host?.textContent).toContain("This page could not be loaded");
      act(() =>
        root?.render(
          createElement(
            RouteErrorBoundary,
            { resetKey: "/tasks" },
            createElement("p", null, "Tasks page")
          )
        )
      );
      expect(host?.textContent).toContain("Tasks page");
      expect(host?.textContent).not.toContain("This page could not be loaded");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("loadWithRetry", () => {
  it("recovers when a page file loads on a later try", async () => {
    let calls = 0;
    const result = await loadWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("Failed to fetch dynamically imported module");
        return { default: "page" };
      },
      { attempts: 3, delayMs: 0 }
    );
    expect(result).toEqual({ default: "page" });
    expect(calls).toBe(3);
  });

  it("gives up after a bounded number of tries", async () => {
    let calls = 0;
    await expect(
      loadWithRetry(
        async () => {
          calls += 1;
          throw new Error("Failed to fetch dynamically imported module");
        },
        { attempts: 3, delayMs: 0 }
      )
    ).rejects.toThrow("Failed to fetch dynamically imported module");
    expect(calls).toBe(3);
  });
});

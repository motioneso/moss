// @vitest-environment jsdom
import { act, createElement, Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lazyWithRetry, loadWithRetry } from "../../apps/web/src/shell/lazy-with-retry.js";
import { RouteErrorBoundary } from "../../apps/web/src/shell/route-error-boundary.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

let consoleSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy?.mockRestore();
  act(() => root?.unmount());
  host?.remove();
  document.body.replaceChildren();
  root = undefined;
});

describe("RouteErrorBoundary", () => {
  it("renders the page when nothing goes wrong", () => {
    mount(
      <RouteErrorBoundary resetKey="/today">
        <p>Today page</p>
      </RouteErrorBoundary>
    );
    expect(host?.textContent).toContain("Today page");
    expect(host?.textContent).not.toContain("This page could not be loaded");
  });

  it("shows a page-only error with a reload offer when a page fails to load", () => {
    mount(
      <RouteErrorBoundary resetKey="/today">
        <div>
          <BrokenPage />
          <p>Today page</p>
        </div>
      </RouteErrorBoundary>
    );
    expect(host?.textContent).toContain("This page could not be loaded");
    expect(host?.textContent).toContain("Reload page");
    expect(host?.textContent).not.toContain("Today page");
  });

  it("clears the error when the person moves to another page", () => {
    mount(
      <RouteErrorBoundary resetKey="/today">
        <BrokenPage />
      </RouteErrorBoundary>
    );
    expect(host?.textContent).toContain("This page could not be loaded");
    act(() =>
      root?.render(
        <RouteErrorBoundary resetKey="/tasks">
          <p>Tasks page</p>
        </RouteErrorBoundary>
      )
    );
    expect(host?.textContent).toContain("Tasks page");
    expect(host?.textContent).not.toContain("This page could not be loaded");
  });

  it("loads the page on Try again after a failed import", async () => {
    let calls = 0;
    const RecoveredPage = lazyWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("Failed to fetch dynamically imported module");
        return { default: () => createElement("p", null, "Recovered page") };
      },
      { attempts: 1, delayMs: 0 }
    );
    mount(
      <RouteErrorBoundary resetKey="/today">
        <Suspense fallback={<p>Loading</p>}>
          <RecoveredPage />
        </Suspense>
      </RouteErrorBoundary>
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host?.textContent).toContain("This page could not be loaded");
    const tryAgain = [...(host?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Try again"
    );
    await act(async () => {
      tryAgain?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host?.textContent).toContain("Recovered page");
    expect(host?.textContent).not.toContain("This page could not be loaded");
    expect(calls).toBe(2);
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

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientApi from "../../apps/web/src/api/client.js";
import type { OnboardingStatusResponse } from "@moss/shared";
const api = vi.hoisted(() => ({ complete: vi.fn(), skip: vi.fn(), replace: vi.fn() }));
vi.mock("../../apps/web/src/api/client.js", async (original) => ({
  ...(await original<typeof ClientApi>()),
  completeOnboarding: api.complete,
  skipOnboarding: api.skip,
  getOnboardingStatus: async () => status
}));
vi.mock("../../apps/web/src/onboarding/chat-availability.js", () => ({
  useChatAvailable: () => true
}));
vi.mock("../../apps/web/src/onboarding/member-connector-step.js", () => ({
  MemberConnectorStep: () => <p>Accounts</p>
}));
vi.mock("../../apps/web/src/onboarding/api-key-opt-out-step.js", () => ({
  ApiKeyOptOutStep: () => <p>Assistant</p>
}));
vi.mock("../../apps/web/src/onboarding/section-tour-step.js", () => ({
  SectionTourStep: () => <p>Tour</p>
}));
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { OnboardingWizard } from "../../apps/web/src/onboarding/onboarding-wizard.js";
const status: OnboardingStatusResponse = {
  role: "member",
  completed: false,
  steps: { apiKeyOptOut: { done: false }, connectors: { done: false } }
};
let root: Root | undefined;
let host: HTMLDivElement;
let client: QueryClient;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function renderWizard(actorUserId = "actor-one", onDone = vi.fn()) {
  client.setQueryData(queryKeys.auth.me, { user: { id: actorUserId } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <OnboardingWizard actorUserId={actorUserId} initialStatus={status} onDone={onDone} />
      </QueryClientProvider>
    )
  );
}
async function mount(onDone = vi.fn()) {
  window.history.replaceState({}, "", "/setup");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } }
  });
  await renderWizard("actor-one", onDone);
}
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.textContent?.trim().startsWith(text)
  )!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const realWindow = window;
  vi.stubGlobal(
    "window",
    new Proxy(realWindow, {
      get(target, key) {
        if (key === "location")
          return {
            href: target.location.href,
            pathname: target.location.pathname,
            replace: api.replace
          };
        return Reflect.get(target, key, target);
      }
    })
  );
  api.replace.mockReset();
  api.complete.mockReset();
  api.skip.mockReset();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  client?.clear();
  root = undefined;
  vi.unstubAllGlobals();
});
function startCompletion(action: "finish" | "skip") {
  if (action === "finish") {
    for (let index = 0; index < 4; index++) {
      act(() => button(index === 0 ? "Start setup" : "Continue").click());
    }
  }
  act(() => button(action === "finish" ? "Finish setup" : "Skip setup").click());
}
describe("audit onboarding persisted completion recovery", () => {
  it.each(["skip", "finish"] as const)(
    "does not reconcile or navigate after %s resolves following navigation and unmount",
    async (action) => {
      let resolve!: (value: object) => void;
      api[action === "finish" ? "complete" : "skip"].mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      const onDone = vi.fn();
      await mount(onDone);
      startCompletion(action);
      await settle();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () =>
        root?.render(
          <QueryClientProvider client={client}>
            <p>Elsewhere</p>
          </QueryClientProvider>
        )
      );
      window.history.pushState({}, "", "/settings");
      await act(async () => resolve({}));
      await settle();
      expect(invalidate).not.toHaveBeenCalled();
      expect(api.replace).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe("/settings");
    }
  );
  it.each(["skip", "finish"] as const)(
    "does not reconcile another account when an old %s resolves",
    async (action) => {
      let resolve!: (value: object) => void;
      api[action === "finish" ? "complete" : "skip"].mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      const oldDone = vi.fn();
      const currentDone = vi.fn();
      await mount(oldDone);
      startCompletion(action);
      await settle();
      await renderWizard("actor-two", currentDone);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () => resolve({}));
      await settle();
      expect(invalidate).not.toHaveBeenCalled();
      expect(api.replace).not.toHaveBeenCalled();
      expect(oldDone).not.toHaveBeenCalled();
      expect(currentDone).not.toHaveBeenCalled();
      expect(button("Skip setup").disabled).toBe(false);
    }
  );
  it("reconciles a same-account remount through its current handler", async () => {
    let resolve!: (value: object) => void;
    api.skip.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const oldDone = vi.fn();
    const currentDone = vi.fn();
    await mount(oldDone);
    act(() => button("Skip setup").click());
    await settle();
    await act(async () => root?.unmount());
    root = createRoot(host);
    await renderWizard("actor-one", currentDone);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => resolve({}));
    await settle();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.onboarding.status });
    expect(oldDone).not.toHaveBeenCalled();
    expect(currentDone).toHaveBeenCalledTimes(1);
    expect(api.skip).toHaveBeenCalledTimes(1);
  });
  it("reconciles the current account without taking over a changed address", async () => {
    let resolve!: (value: object) => void;
    api.skip.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const onDone = vi.fn();
    await mount(onDone);
    act(() => button("Skip setup").click());
    await settle();
    window.history.pushState({}, "", "/settings");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => resolve({}));
    await settle();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.onboarding.status });
    expect(onDone).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/settings");
  });

  it("reconciles successful completion when the same account returns after it settled unmounted", async () => {
    let resolve!: (value: object) => void;
    api.skip.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const oldDone = vi.fn();
    const currentDone = vi.fn();
    await mount(oldDone);
    startCompletion("skip");
    await settle();
    await act(async () => root?.unmount());
    root = undefined;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => resolve({}));
    await settle();
    expect(invalidate).not.toHaveBeenCalled();
    expect(oldDone).not.toHaveBeenCalled();
    root = createRoot(host);
    await renderWizard("actor-one", currentDone);
    await settle();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.onboarding.status });
    expect(currentDone).toHaveBeenCalledTimes(1);
    expect(api.skip).toHaveBeenCalledTimes(1);
  });
  it("checks current authentication even before actor props can catch up", async () => {
    let resolve!: (value: object) => void;
    api.skip.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const onDone = vi.fn();
    await mount(onDone);
    startCompletion("skip");
    await settle();
    client.setQueryData(queryKeys.auth.me, { user: { id: "actor-two" } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => resolve({}));
    await settle();
    expect(invalidate).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
  it("keeps a pending completion locked through remount on the same account", async () => {
    api.skip.mockImplementation(() => new Promise(() => {}));
    await mount();
    act(() => button("Skip setup").click());
    await settle();
    await act(async () => root?.unmount());
    root = createRoot(host);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <OnboardingWizard actorUserId="actor-one" initialStatus={status} onDone={vi.fn()} />
        </QueryClientProvider>
      )
    );
    expect(button("Skip setup").disabled).toBe(true);
    act(() => button("Skip setup").click());
    expect(api.skip).toHaveBeenCalledTimes(1);
  });
  it("does not reuse another account's pending completion state", async () => {
    api.skip.mockImplementation(() => new Promise(() => {}));
    await mount();
    act(() => button("Skip setup").click());
    await settle();
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <OnboardingWizard actorUserId="actor-two" initialStatus={status} onDone={vi.fn()} />
        </QueryClientProvider>
      )
    );
    expect(button("Skip setup").disabled).toBe(false);
  });
  it("shows skip failure and retries the same action without losing current step", async () => {
    api.skip.mockRejectedValueOnce(new Error("private backend detail")).mockResolvedValueOnce({});
    await mount();
    act(() => button("Skip setup").click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not skip setup");
    expect(host.textContent).not.toContain("private backend detail");
    expect(button("Start setup")).toBeDefined();
    act(() => button("Retry skip").click());
    await settle();
    expect(api.skip).toHaveBeenCalledTimes(2);
  });
  it("shows finish failure on the retained Finish step and offers retry", async () => {
    api.complete.mockRejectedValue(new Error("failed"));
    await mount();
    for (let index = 0; index < 4; index++) {
      act(() => button(index === 0 ? "Start setup" : "Continue").click());
    }
    act(() => button("Finish setup").click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not finish setup");
    expect(button("Finish setup")).toBeDefined();
    act(() => button("Retry finish").click());
    await settle();
    expect(api.complete).toHaveBeenCalledTimes(2);
  });
  it("guards concurrent skip calls before mutation state renders", async () => {
    api.skip.mockImplementation(() => new Promise(() => {}));
    await mount();
    const skip = button("Skip setup");
    act(() => {
      skip.click();
      skip.click();
    });
    await settle();
    expect(api.skip).toHaveBeenCalledTimes(1);
    expect(skip.disabled).toBe(true);
  });
});

// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientApi from "../../apps/web/src/api/client.js";
import type { MeResponse } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
const api = vi.hoisted(() => ({
  me: vi.fn(),
  modules: vi.fn(),
  myModules: vi.fn(),
  signOut: vi.fn(),
  mounted: vi.fn()
}));
vi.mock("../../apps/web/src/api/client.js", async (original) => ({
  ...(await original<typeof ClientApi>()),
  getMe: api.me,
  getModules: api.modules,
  getMyModules: api.myModules,
  signOut: api.signOut
}));
vi.mock("../../apps/web/src/shell/app-shell.js", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>
}));
vi.mock("../../apps/web/src/wellness/wellness-page.js", () => ({
  WellnessPage: () => {
    api.mounted();
    return <p>Wellness mounted</p>;
  }
}));
vi.mock("../../apps/web/src/today/today-page.js", () => ({
  TodayPage: () => <p>Today mounted</p>
}));
vi.mock("../../apps/web/src/tasks/tasks-page.js", () => ({
  TasksPage: () => <p>Tasks mounted</p>
}));
import { ApiError } from "../../apps/web/src/api/client.js";
import { App } from "../../apps/web/src/app.js";
const me: MeResponse = {
  user: {
    id: "owner",
    email: "owner@example.test",
    emailVerified: true,
    name: "Owner",
    isInstanceAdmin: false,
    isBootstrapOwner: false,
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};
let client: QueryClient;
let root: Root | undefined;
let host: HTMLDivElement;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function mount(path: string, authenticated = true) {
  window.history.replaceState({}, "", path);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } }
  });
  client.setQueryData(queryKeys.auth.bootstrap, { needsBootstrap: false });
  if (authenticated) client.setQueryData(queryKeys.auth.me, me);
  client.setQueryData(queryKeys.onboarding.status, { role: "member", completed: true });
  client.setQueryData(queryKeys.settings.persona, {});
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    )
  );
  await settle();
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label
  )!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(api).forEach((mock) => mock.mockReset());
  api.modules.mockResolvedValue({ modules: [] });
  api.myModules.mockResolvedValue({ modules: [{ id: "wellness", active: true }] });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  client?.clear();
  root = undefined;
  vi.unstubAllGlobals();
});
describe("audit account and module gate recovery", () => {
  it.each(["account_pending_approval", "account_deactivated"])(
    "offers authoritative recheck and sign out for %s",
    async (code) => {
      api.me.mockRejectedValueOnce(new ApiError(403, "blocked", code)).mockResolvedValueOnce(me);
      await mount("/today", false);
      expect(button("Check again")).toBeDefined();
      expect(button("Sign out")).toBeDefined();
      act(() => button("Check again").click());
      await settle();
      await settle();
      expect(host.textContent).toContain("Today mounted");
    }
  );
  it.each([
    [
      "account_pending_approval",
      "account_deactivated",
      "Your account has been deactivated.",
      "pending approval"
    ],
    [
      "account_deactivated",
      "account_pending_approval",
      "Your account is pending approval by an administrator.",
      "has been deactivated"
    ]
  ])("updates the headline after %s changes to %s", async (initial, latest, headline, obsolete) => {
    api.me
      .mockRejectedValueOnce(new ApiError(403, "blocked", initial))
      .mockRejectedValueOnce(new ApiError(403, "blocked", latest));
    await mount("/today", false);
    act(() => button("Check again").click());
    await settle();
    expect(host.textContent).toContain(headline);
    expect(host.textContent).not.toContain(obsolete);
  });
  it("retains the latest authoritative status through a later unavailable recheck", async () => {
    api.me
      .mockRejectedValueOnce(new ApiError(403, "pending", "account_pending_approval"))
      .mockRejectedValueOnce(new ApiError(403, "deactivated", "account_deactivated"))
      .mockRejectedValueOnce(new Error("unavailable"));
    await mount("/today", false);
    act(() => button("Check again").click());
    await settle();
    expect(host.textContent).toContain("Your account has been deactivated.");
    act(() => button("Check again").click());
    await settle();
    expect(host.textContent).toContain("Your account has been deactivated.");
    expect(host.textContent).not.toContain("pending approval");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not check your account"
    );
  });
  it("keeps pending-account recovery controls after a failed recheck", async () => {
    api.me
      .mockRejectedValueOnce(new ApiError(403, "pending", "account_pending_approval"))
      .mockRejectedValueOnce(new Error("unavailable"));
    await mount("/today", false);
    act(() => button("Check again").click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not check your account"
    );
    expect(button("Sign out")).toBeDefined();
  });
  it("retains a Wellness deep link on unavailable module state, then mounts only after explicit enablement", async () => {
    api.myModules
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ modules: [{ id: "wellness", active: true }] });
    await mount("/wellness?day=2026-10-11");
    expect(window.location.pathname + window.location.search).toBe("/wellness?day=2026-10-11");
    expect(api.mounted).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Could not check module access");
    act(() => button("Retry").click());
    await settle();
    await settle();
    expect(api.mounted).toHaveBeenCalled();
  });
  it("still redirects an explicitly disabled module without mounting its children", async () => {
    api.myModules.mockResolvedValue({ modules: [{ id: "wellness", active: false }] });
    await mount("/wellness");
    expect(api.mounted).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/tasks");
  });
  it("retains an external deep link when registry discovery fails", async () => {
    api.modules.mockRejectedValue(new Error("unavailable"));
    await mount("/m/example/details?view=one");
    expect(window.location.pathname + window.location.search).toBe("/m/example/details?view=one");
    expect(host.textContent).toContain("Could not load modules");
    expect(button("Retry")).toBeDefined();
  });
});

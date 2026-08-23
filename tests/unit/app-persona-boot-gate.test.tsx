/**
 * #1482/#1451 regression — commit 5ef6f3352 added `if (personaQuery.isLoading) return
 * <LoadingScreen />;` to apps/web/src/app.tsx, gating the ENTIRE app shell boot on the persona
 * fetch rather than just the surfaces that display the assistant name. No e2e fixture stubs
 * `/api/me/persona`, so every fresh page load across the whole branch e2e suite now pays that
 * fetch's latency before anything renders — Fable's diagnosis for PR #1482's 31 e2e timeouts.
 *
 * Renders the real `App` default export with every other boot query pre-resolved in the query
 * cache and only persona forced into a pending fetch, to prove boot no longer blocks on it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import type * as ReactRouter from "react-router";

// This repo's root vitest suite has no DOM environment (see app-shell-chat-surface.test.tsx) —
// app.tsx's initial useState(() => loadShellTheme()) call hits theme-storage's bare `localStorage`
// global, which doesn't exist under Node.
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => undefined
} as unknown as Storage);

// app.tsx calls installModuleHostRuntime() at module scope (#918), which reads the bare `window`
// global to install a module-runtime marker — also absent under Node.
vi.stubGlobal("window", {} as unknown as Window & typeof globalThis);

// app.tsx hardcodes <BrowserRouter>, which constructs browser history from `window.history` at
// render time — unavailable under this DOM-less renderToString convention. Swap it for
// MemoryRouter's implementation; app.tsx itself needs no change to pick this up.
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>();
  return { ...actual, BrowserRouter: actual.MemoryRouter };
});

// Isolates the boot-gate question from the rest of the shell tree (sidebar, drawer, lazy routes,
// external modules) — we only care whether execution reaches the point that mounts AppShell.
const appShellMounts: unknown[] = [];
vi.mock("../../apps/web/src/shell/app-shell.js", () => ({
  AppShell: (props: unknown) => {
    appShellMounts.push(props);
    return createElement("div", { "data-testid": "app-shell-mounted" });
  }
}));

const { App } = await import("../../apps/web/src/app.js");

const ME: MeResponse = {
  user: {
    id: "user-1",
    email: "user@example.com",
    emailVerified: true,
    name: "Test User",
    isInstanceAdmin: false,
    status: "active",
    isBootstrapOwner: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

function renderApp(client: QueryClient): string {
  return renderToString(createElement(QueryClientProvider, { client }, createElement(App)));
}

describe("app boot does not block on personaQuery (#1451/#1482)", () => {
  it("mounts the app shell while the persona fetch is still pending", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.auth.bootstrap, { needsBootstrap: false });
    client.setQueryData(queryKeys.auth.me, ME);
    client.setQueryData(queryKeys.modules, { modules: [] });
    client.setQueryData(queryKeys.myModules, { modules: [] });
    client.setQueryData(queryKeys.onboarding.status, {
      role: "member",
      completed: true
    });
    // Force personaQuery into an in-flight, never-resolving fetch (status: pending, fetchStatus:
    // fetching) — the exact state its .isLoading gate checked. Deliberately not awaited.
    void client.fetchQuery({
      queryKey: queryKeys.settings.persona,
      queryFn: () => new Promise(() => {})
    });

    const html = renderApp(client);

    expect(appShellMounts.length).toBeGreaterThan(0);
    expect(html).toContain("app-shell-mounted");
    expect(html).not.toContain("Loading Moss");
  });
});

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  ListMyModuleBuildsResponse,
  ListMyModulesResponse,
  MeResponse,
  ModuleBuildSummary
} from "@moss/shared";

import { WorkshopPage, hasActiveBuild } from "../../packages/workshop/src/web/workshop-page.js";

// Root suite renders @moss/web components with react-dom/server (no jsdom /
// @testing-library — deliberately avoided repo-wide; see settings-appearance-pane.test.tsx).
// useQuery reads primed cache synchronously during renderToString, so the resolved
// state is asserted against the SSR HTML string.

function meResponse(isInstanceAdmin: boolean): MeResponse {
  return {
    user: {
      id: "u-1",
      email: "admin@example.com",
      emailVerified: true,
      name: "Admin",
      isInstanceAdmin,
      status: "active",
      isBootstrapOwner: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z"
    },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  };
}

function render(
  me?: MeResponse,
  builds?: ListMyModuleBuildsResponse,
  modules?: ListMyModulesResponse
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (me) client.setQueryData(["workshop", "me"], me);
  client.setQueryData(["workshop", "module-builds", "mine"], builds ?? { builds: [] });
  client.setQueryData(["workshop", "modules", "mine"], modules ?? { modules: [] });
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(WorkshopPage))
  );
}

describe("WorkshopPage", () => {
  it("uses the shell title instead of repeating it in the page", () => {
    const html = render(meResponse(true));
    expect(html).not.toContain(">The workshop<");
    expect(html).toContain("See what Moss is building for you");
  });

  it("falls back to the empty state when nothing is building or live", () => {
    const html = render(meResponse(true));
    expect(html).toContain("Nothing in the workshop yet");
  });

  it("shows an access-denied empty state for a non-admin, not the workshop groups", () => {
    const html = render(meResponse(false));
    expect(html).toContain("The workshop is for instance admins");
    expect(html).not.toContain("Nothing in the workshop yet");
  });

  it("shows a real build from /api/ai/module-builds/mine, not the empty state", () => {
    const html = render(meResponse(true), {
      builds: [
        {
          id: "b-1",
          status: "building",
          step: "Writing the page",
          plan: null,
          fetchedUrls: [],
          writtenFiles: [],
          costCents: 10,
          error: null,
          createdAt: "2026-08-20T09:00:00Z",
          updatedAt: "2026-08-20T09:00:00Z"
        }
      ]
    });
    expect(html).toContain("Building now");
    expect(html).not.toContain("Nothing in the workshop yet");
  });

  it("only shows optional modules created by the logged-in user", () => {
    const html = render(meResponse(true), undefined, {
      modules: [
        {
          id: "finance",
          name: "Finance",
          version: "0.1.0",
          lifecycle: "required",
          required: true,
          supportsUserDisable: false,
          instanceDisabled: false,
          userDisabled: false,
          active: true,
          hasPreferences: false,
          hasUserCredentials: false,
          scope: "everyone"
        },
        {
          id: "gmm",
          name: "GMM tracker",
          version: "0.1.0",
          lifecycle: "optional",
          required: false,
          supportsUserDisable: true,
          instanceDisabled: false,
          userDisabled: false,
          active: true,
          hasPreferences: false,
          hasUserCredentials: false,
          scope: "you"
        },
        {
          id: "someone-elses-module",
          name: "Someone else's module",
          version: "0.1.0",
          lifecycle: "optional",
          required: false,
          supportsUserDisable: true,
          instanceDisabled: false,
          userDisabled: false,
          active: true,
          hasPreferences: false,
          hasUserCredentials: false,
          scope: "everyone"
        }
      ]
    });
    expect(html).toContain("GMM tracker");
    expect(html).not.toContain("Finance");
    expect(html).not.toContain("Someone else&#x27;s module");
  });
});

function build(status: ModuleBuildSummary["status"]): ModuleBuildSummary {
  return {
    id: "b-1",
    status,
    step: null,
    plan: null,
    fetchedUrls: [],
    writtenFiles: [],
    costCents: 0,
    error: null,
    createdAt: "2026-08-20T09:00:00Z",
    updatedAt: "2026-08-20T09:00:00Z"
  };
}

describe("hasActiveBuild", () => {
  it("is false when there is no data yet", () => {
    expect(hasActiveBuild(undefined)).toBe(false);
  });

  it("is false when every build is terminal or waiting on the human", () => {
    expect(
      hasActiveBuild({
        builds: [
          build("awaiting_plan_approval"),
          build("awaiting_change"),
          build("ready"),
          build("failed"),
          build("cancelled")
        ]
      })
    ).toBe(false);
  });

  it("is true when a build is planning", () => {
    expect(hasActiveBuild({ builds: [build("planning")] })).toBe(true);
  });

  it("is true when a build is building", () => {
    expect(hasActiveBuild({ builds: [build("building")] })).toBe(true);
  });
});

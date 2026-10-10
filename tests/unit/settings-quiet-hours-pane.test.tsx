import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GetQuietHoursSettingsResponse, MeResponse } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ApiError } from "../../apps/web/src/api/client.js";
import {
  isValidQuietHoursTime,
  quietHoursSaveRequest
} from "../../apps/web/src/settings/settings-quiet-hours-draft.js";

vi.mock("virtual:moss-module-settings", () => ({
  MODULE_SETTINGS_SURFACES: [],
  MODULE_SETTINGS_COMPONENTS: {}
}));

const quietHours: GetQuietHoursSettingsResponse = {
  quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "America/Chicago" },
  authority: { status: "canonical", alerts: null },
  version: "3:1700000000000"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("quiet-hours settings client", () => {
  it("uses the current-user quiet-hours API for reads and writes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(quietHours), { status: 200 }))
      );
    const { getQuietHoursSettings, putQuietHoursSettings } =
      await import("../../apps/web/src/api/client.js");

    await expect(getQuietHoursSettings()).resolves.toEqual(quietHours);
    await expect(
      putQuietHoursSettings({
        quietHours: quietHours.quietHours,
        expectedVersion: "3:1700000000000"
      })
    ).resolves.toEqual(quietHours);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/me/quiet-hours",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/me/quiet-hours",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          quietHours: quietHours.quietHours,
          expectedVersion: "3:1700000000000"
        }),
        credentials: "include"
      })
    );
  });

  it("has a dedicated settings query key", () => {
    expect(queryKeys.settings.quietHours).toEqual(["settings", "quiet-hours"]);
  });
});

describe("quiet-hours save request", () => {
  const next = { ...quietHours.quietHours, start: "23:00" };

  it("sends the version the controls were loaded from", () => {
    expect(quietHoursSaveRequest(next, quietHours)).toEqual({
      quietHours: next,
      expectedVersion: "3:1700000000000"
    });
  });

  it("expects no saved schedule when none was loaded", () => {
    expect(quietHoursSaveRequest(next, { ...quietHours, version: null })).toEqual({
      quietHours: next,
      expectedVersion: null
    });
    expect(quietHoursSaveRequest(next, undefined).expectedVersion).toBeNull();
  });
});

describe("isValidQuietHoursTime", () => {
  it("accepts valid HH:MM", () => {
    expect(isValidQuietHoursTime("22:00")).toBe(true);
    expect(isValidQuietHoursTime("07:05")).toBe(true);
  });
  it("rejects empty string and malformed values", () => {
    expect(isValidQuietHoursTime("")).toBe(false);
    expect(isValidQuietHoursTime("24:00")).toBe(false);
    expect(isValidQuietHoursTime("7:5")).toBe(false);
  });
});

// #3130 - Profile only summarises quiet hours; the one editor lives in Alerts & quiet hours.
describe("ProfilePane quiet-hours summary", () => {
  const locale = (client: QueryClient) =>
    client.setQueryData(queryKeys.settings.locale, {
      locale: { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "24" }
    });

  it("names the saved schedule and has no quiet-hours controls of its own", async () => {
    const html = await renderPane((client) => {
      locale(client);
      client.setQueryData(queryKeys.settings.quietHours, quietHours);
    });

    expect(html).toContain("Saved schedule: every day, 22:00 to 07:00, America/Chicago time.");
    expect(html).toContain("Edit quiet hours");
    expect(html).not.toContain('aria-label="Enable quiet hours"');
    expect(html).not.toContain('aria-label="Quiet hours from"');
    expect(html).not.toContain(["Saving quiet hours", " is coming soon"].join(""));
  });

  it("opens Alerts & quiet hours from Edit quiet hours", async () => {
    const onSelectSection = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    locale(client);
    client.setQueryData(queryKeys.settings.quietHours, quietHours);
    const tree = await profileTree(client, onSelectSection);

    const link = tree.root.find(
      (node) => node.type === "button" && textOf(node.children) === "Edit quiet hours"
    );
    act(() => {
      link.props.onClick();
    });

    expect(onSelectSection).toHaveBeenCalledWith("alerts");
    act(() => tree.unmount());
  });

  it("says the schedule is loading until it arrives", async () => {
    const html = await renderPane(() => {});

    expect(html).toContain("Loading quiet hours");
  });

  it("shows why the schedule could not load", async () => {
    const html = await renderPane(
      (client) => {
        client
          .getQueryCache()
          .build(client, { queryKey: queryKeys.settings.quietHours })
          .setState({
            status: "error",
            fetchStatus: "idle",
            error: new ApiError(503, "Quiet hours are unavailable right now"),
            errorUpdatedAt: Date.now()
          });
      },
      { retryOnMount: false }
    );

    expect(html).toContain("Quiet hours are unavailable right now");
    expect(html).not.toContain("Loading quiet hours");
  });

  it("offers Try again after a failed load and shows the schedule once it loads", async () => {
    let quietHoursCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const respond = (value: unknown, status = 200) =>
        Promise.resolve(new Response(JSON.stringify(value), { status }));
      if (String(input) !== "/api/me/quiet-hours") return respond({ error: "unused" }, 503);
      quietHoursCalls += 1;
      return quietHoursCalls === 1
        ? respond({ error: "Quiet hours are unavailable right now" }, 503)
        : respond(quietHours);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    locale(client);
    const tree = await profileTree(client, () => {});
    await settle();

    const retry = () =>
      tree.root.findAll((node) => node.type === "button" && textOf(node.children) === "Try again");
    expect(textOf(tree.toJSON())).toContain("Quiet hours are unavailable right now");
    expect(retry()).toHaveLength(1);

    await act(async () => {
      retry()[0]!.props.onClick();
    });
    await settle();

    expect(quietHoursCalls).toBe(2);
    expect(textOf(tree.toJSON())).toContain("Saved schedule: every day, 22:00 to 07:00");
    expect(retry()).toHaveLength(0);
    act(() => tree.unmount());
  });

  it("never calls a conflicting schedule the saved setting", async () => {
    const html = await renderPane((client) => {
      locale(client);
      client.setQueryData(queryKeys.settings.quietHours, {
        ...quietHours,
        authority: { status: "conflict", alerts: { enabled: true, start: "23:00", end: "08:00" } }
      } satisfies GetQuietHoursSettingsResponse);
    });

    expect(html).toContain("Notifications follow: every day, 22:00 to 07:00");
    expect(html).toContain("Email alerts follow a different saved schedule.");
    expect(html).not.toContain("Saved schedule");
  });
});

const me: MeResponse = {
  user: {
    id: "u1",
    email: "u@example.test",
    emailVerified: true,
    name: "U",
    status: "active",
    isInstanceAdmin: false,
    isBootstrapOwner: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

async function renderPane(
  seed: (client: QueryClient) => void,
  queries: { retryOnMount?: boolean } = {}
): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, ...queries } } });
  seed(client);
  const { FeedbackProvider } = await import("../../apps/web/src/settings/settings-feedback.js");
  const { ProfilePane } = await import("../../apps/web/src/settings/settings-personal-panes.js");
  return renderToString(
    createElement(
      FeedbackProvider,
      null,
      createElement(
        QueryClientProvider,
        { client },
        createElement(ProfilePane, { me, onNavigate: () => {} }) as ReactElement
      )
    )
  );
}

async function profileTree(client: QueryClient, onSelectSection: (id: string) => void) {
  const { FeedbackProvider } = await import("../../apps/web/src/settings/settings-feedback.js");
  const { ProfilePane } = await import("../../apps/web/src/settings/settings-personal-panes.js");
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      createElement(
        FeedbackProvider,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(ProfilePane, { me, onNavigate: () => {}, onSelectSection }) as ReactElement
        )
      )
    );
  });
  return tree;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf((node as { children?: unknown }).children);
}

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@moss/shared";

const queryOptions = vi.hoisted(() => ({
  current: null as { retry?: boolean; queryKey?: unknown } | null
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: { retry?: boolean; queryKey?: unknown }) => {
    queryOptions.current = options;
    return {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn()
    };
  })
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  listActionAuditLog: vi.fn(),
  // ActivityPane resolves the configured assistant name via useAssistantName, which imports
  // getPersonaSettings from this module — the mock must define it or the import throws. useQuery
  // is mocked below (ignores queryFn), so this is never actually called.
  getPersonaSettings: vi.fn()
}));

vi.mock("../../apps/web/src/locale/locale-format.js", () => ({
  formatDateTime: vi.fn(() => "July 16, 2026"),
  useUserLocale: vi.fn(() => ({ timezone: "UTC", region: "en-US", dateFormat: "24" }))
}));

import { ActivityPane } from "../../apps/web/src/settings/settings-activity-pane.js";

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

describe("ActivityPane", () => {
  it("shows bounded recovery instead of endless loading or false empty state", () => {
    const html = renderToString(createElement(ActivityPane, { me, onNavigate: () => undefined }));

    expect(html).toContain("Activity unavailable");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Loading…");
    expect(html).not.toContain("No Jarvis actions in this period.");
    expect(queryOptions.current).toMatchObject({ retry: false });
  });

  it("keeps the query key stable across re-renders when Date.now() ticks (PR #1117 CP5)", () => {
    // Unmemoized, `since` for non-"today" ranges was derived fresh from Date.now() on every
    // render, so an abort/error re-render minted a new query key and the component remounted
    // into isLoading forever instead of ever observing isError. See settings-activity-pane.tsx.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      let renderer!: ReturnType<typeof create>;
      act(() => {
        renderer = create(createElement(ActivityPane, { me, onNavigate: () => undefined }));
      });
      const firstKey = queryOptions.current?.queryKey;

      nowSpy.mockReturnValue(1_700_000_050_000);
      act(() => {
        renderer.update(createElement(ActivityPane, { me, onNavigate: () => undefined }));
      });
      const secondKey = queryOptions.current?.queryKey;

      expect(firstKey).toBeDefined();
      expect(secondKey).toEqual(firstKey);

      act(() => {
        renderer.unmount();
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

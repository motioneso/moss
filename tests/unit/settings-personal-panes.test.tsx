import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { MeResponse } from "@moss/shared";

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

describe("ProfilePane merged Account & preferences", () => {
  it("keeps blank coordinates invalid instead of coercing them to zero", async () => {
    const { parseWeatherLocationFields } =
      await import("../../apps/web/src/settings/settings-personal-panes.js");

    expect(parseWeatherLocationFields({ label: "Home", lat: "", lon: "" })).toBeNull();
    expect(parseWeatherLocationFields({ label: "Null Island", lat: "0", lon: "0" })).toEqual({
      label: "Null Island",
      lat: 0,
      lon: 0
    });
  });

  it("renders locale and quiet hours alongside identity/account", async () => {
    const html = await renderProfilePane();
    expect(html).toContain("Account &amp; preferences");
    expect(html).toContain("Quiet hours");
    expect(html).toContain("Location");
    expect(html).toContain(">Weather<");
    expect(html).toContain(
      "Search for a place to use instead of approximate timezone-based detection."
    );
    expect(html).toContain(">Unit<");
    expect(html).toContain(">Member<");
    expect(html).not.toContain(">Active<");
    expect(html).not.toContain(">Role<");
    expect(html).not.toContain("Auth provider configuration");
  });

  it("reflects a primed weather location override in the current-location row", async () => {
    const html = await renderProfilePane({
      location: { label: "Home", lat: 51.5072, lon: -0.1276 }
    });
    expect(html).toContain("Currently using Home.");
  });

  it("renders every supported time zone and disables unsupported language controls", async () => {
    const html = await renderProfilePane();
    expect(
      Intl.supportedValuesOf("timeZone").every((timeZone) => html.includes(`value="${timeZone}"`))
    ).toBe(true);
    expect(html).toMatch(/aria-label="Language &amp; region"[^>]*disabled/);
  });

  it("renders Data export before Danger zone and does not claim export is unavailable", async () => {
    const html = await renderProfilePane();
    const exportIndex = html.indexOf("Your data");
    const dangerIndex = html.indexOf("Danger zone");
    expect(exportIndex).toBeGreaterThan(-1);
    expect(dangerIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(dangerIndex);
    expect(html).not.toContain("Data export isn't available yet");
  });
});

async function renderProfilePane(
  weatherLocation: { location: { label: string; lat: number; lon: number } | null } = {
    location: null
  }
): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { queryKeys } = await import("../../apps/web/src/api/query-keys.js");
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "24" }
  });
  client.setQueryData(queryKeys.settings.quietHours, {
    quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: null }
  });
  client.setQueryData(queryKeys.weather.location, weatherLocation);
  client.setQueryData(queryKeys.weather.unit, { unit: "metric" });
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

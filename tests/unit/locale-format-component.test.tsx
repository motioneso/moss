import { createElement, type JSX } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { LocaleSettingsDto } from "@moss/shared";

import { formatDateTime, useUserLocale } from "../../apps/web/src/locale/locale-format.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";

/**
 * Component-level proof for #579: a date routed through the shared formatter renders in
 * the user's *persisted* locale (seeded into the `/api/me/locale` query), not the
 * ambient runtime zone. The chosen instant straddles a UTC day boundary so the rendered
 * calendar day differs per zone — an ICU-stable, unambiguous signal.
 */

const INSTANT = "2026-06-27T23:30:00.000Z"; // UTC: Jun 27 · New York: Jun 27 19:30 · Tokyo: Jun 28 08:30

function Probe(): JSX.Element {
  const locale = useUserLocale();
  return createElement("output", null, formatDateTime(INSTANT, locale));
}

function renderWithLocale(locale: LocaleSettingsDto | null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (locale) {
    client.setQueryData(queryKeys.settings.locale, { locale });
  }
  return renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)));
}

describe("formatDateTime through useUserLocale (#579 component wiring)", () => {
  const newYork: LocaleSettingsDto = {
    timezone: "America/New_York",
    region: "en-US",
    dateFormat: "24"
  };
  const tokyo: LocaleSettingsDto = { timezone: "Asia/Tokyo", region: "en-US", dateFormat: "24" };

  it("renders the instant in the user's persisted timezone, not the ambient zone", () => {
    const ny = renderWithLocale(newYork);
    expect(ny).toContain("Jun 27");
    expect(ny).toContain("19:30");
  });

  it("renders the same instant on the next calendar day for a forward zone", () => {
    const tk = renderWithLocale(tokyo);
    expect(tk).toContain("Jun 28");
    expect(tk).toContain("08:30");
  });

  it("produces zone-dependent output (never a fixed ambient rendering)", () => {
    expect(renderWithLocale(newYork)).not.toBe(renderWithLocale(tokyo));
  });

  it("falls back to the default locale before the preference resolves", () => {
    // No seeded locale → useUserLocale yields DEFAULT_LOCALE (America/Los_Angeles, Jun 27 16:30).
    const fallback = renderWithLocale(null);
    expect(fallback).toContain("Jun 27");
    expect(fallback).toContain("16:30");
  });
});

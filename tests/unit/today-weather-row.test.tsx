// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { LocaleSettingsDto, MeResponse, WeatherTodayDto } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";
import { TodayWeatherRow } from "../../apps/web/src/today/header-weather.js";
import { TodayPage } from "../../apps/web/src/today/today-page.js";
import * as weatherClient from "../../apps/web/src/api/weather-client.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

const me: MeResponse = {
  user: {
    id: "user-1",
    email: "ben@example.com",
    emailVerified: true,
    name: "Ben",
    isInstanceAdmin: true,
    status: "active",
    isBootstrapOwner: true,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z"
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

function relDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function weather(overrides: Partial<WeatherTodayDto> = {}): WeatherTodayDto {
  return {
    temp: 21,
    feelsLike: 20,
    condition: "Sunny",
    icon: "sun",
    location: "San Francisco, CA",
    unit: "imperial",
    humidity: 55,
    dewPoint: 12,
    windSpeed: 5,
    lat: 37.7,
    lon: -122.4,
    forecast: [0, 1, 2, 3, 4].map((offset) => ({
      date: relDate(offset),
      icon: "sun",
      high: 24 - offset,
      low: 16 - offset
    })),
    ...overrides
  };
}

function renderRow(input: {
  readonly weather?: WeatherTodayDto | null;
  readonly mode?: "day" | "evening";
  readonly isPending?: boolean;
  readonly isError?: boolean;
}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.settings.locale, { locale });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(TodayWeatherRow, {
          weather: input.weather ?? null,
          mode: input.mode ?? "day",
          isPending: input.isPending ?? false,
          isError: input.isError ?? false
        })
      )
    )
  );
}

function tileCount(html: string): number {
  return html.split('class="jds-weather-chip__day"').length - 1;
}

describe("TodayWeatherRow", () => {
  it("shows temperature with unit, condition and high/low in day mode", () => {
    const html = renderRow({ weather: weather() });
    expect(html).toContain("21°F");
    expect(html).toContain("Sunny");
    expect(html).toContain("High 24° / Low 16°");
    expect(html).toContain("San Francisco");
    expect(html).not.toContain("San Francisco, CA");
    expect(tileCount(html)).toBe(6);
    expect(html).toContain("https://www.wunderground.com/weather/37.7,-122.4");
  });

  it("shows the overnight low in evening mode", () => {
    const html = renderRow({ weather: weather(), mode: "evening" });
    expect(html).toContain("Overnight low 16°");
    expect(html).not.toContain("High 24°");
    expect(tileCount(html)).toBe(6);
    expect(html).toContain("https://www.wunderground.com/weather/37.7,-122.4");
  });

  it("renders the authored unavailable line with no numbers when data is null", () => {
    const html = renderRow({ weather: null });
    expect(html).toContain("Weather isn&#x27;t available right now.");
    expect(html).toContain("Weather settings");
    expect(html).toContain('href="/settings?section=profile"');
    expect(html).not.toContain("21°F");
    expect(html).not.toContain("Sunny");
    expect(tileCount(html)).toBe(0);
  });

  it("renders the authored unavailable line on query error", () => {
    const html = renderRow({ weather: weather(), isError: true });
    expect(html).toContain("Weather isn&#x27;t available right now.");
    expect(html).not.toContain("21°F");
  });

  it("renders nothing while pending", () => {
    expect(renderRow({ isPending: true })).toBe("");
  });
});

describe("Today weather fetch", () => {
  it("fetches the shared weather entry exactly once from TodayPage", async () => {
    const spy = vi.spyOn(weatherClient, "getWeatherToday").mockResolvedValue({ data: null });
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } }
      });
      client.setQueryData(queryKeys.settings.locale, { locale });
      client.setQueryData(queryKeys.tasks.list, { tasks: [] });
      client.setQueryData(queryKeys.tasks.lists, { lists: [] });
      client.setQueryData(queryKeys.calendar.list, { events: [] });
      client.setQueryData(queryKeys.goals.list, { items: [] });
      let renderer: ReturnType<typeof create> | undefined;
      await act(async () => {
        renderer = create(
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              ChatControlsProvider,
              {
                value: {
                  openChat: () => undefined,
                  openChatWith: () => undefined,
                  openAssistantWithDraft: () => undefined
                }
              },
              createElement(
                MemoryRouter,
                null,
                createElement(TodayPage, { me, wellnessEnabled: false })
              )
            )
          )
        );
      });
      expect(spy).toHaveBeenCalledTimes(1);
      renderer?.unmount();
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves no weather behind in the shell", () => {
    const shell = readFileSync("apps/web/src/shell/app-shell.tsx", "utf8");
    expect(shell).not.toContain("header-weather");
    expect(shell).not.toContain("getWeatherToday");
    expect(shell).not.toContain("weatherQuery");
    expect(shell).not.toContain("topbar-context");
  });
});

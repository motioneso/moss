import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import type {
  ConnectorAccountDto,
  GetNotificationDigestPreferenceResponse,
  LocaleSettingsDto,
  UsefulnessFeedbackDto
} from "@moss/shared";
import { formatTimestamp, useUserLocale } from "@moss/settings-ui";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { OversightPane } from "../../apps/web/src/settings/settings-admin-panes.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import { sinceForRange } from "../../apps/web/src/settings/settings-activity-pane.js";
import {
  BriefingSettings,
  digestSaveTimezone,
  NotificationSettings
} from "../../apps/web/src/settings/settings-module-subviews.js";
import { formatLastSync } from "../../apps/web/src/settings/settings-personal-data-panes.js";
import { defaultExportRange } from "../../apps/web/src/wellness/export-modal.js";
import BacktrackSettings, {
  chosenDayRange,
  formatDay,
  todayDateValue,
  todayRange
} from "../../packages/backtrack/src/settings/index.js";
import { lastCheckedLabel } from "../../packages/news/src/settings/index.js";
import { StoryFeedbackSettings } from "../../packages/news/src/settings/story-feedback.js";
import { newsQueryKeys } from "../../packages/news/src/web/query-keys.js";
import { StoryPreferencesSection } from "../../packages/sports/src/settings/story-preferences.js";

/*
 * #3396: settings panes show times in the person's saved zone and 12/24-hour choice, never the
 * machine's. The machine runs in UTC; the person is in Los Angeles on 24-hour time. 03:30 UTC on
 * October 10 is 20:30 on October 9 for them.
 */

const LA_24: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "24"
};
const INSTANT = "2026-10-10T03:30:00.000Z";
const NOW = new Date(INSTANT);

let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** A second person who differs from the shared default in zone and clock. */
const TOKYO_12: LocaleSettingsDto = { timezone: "Asia/Tokyo", region: "en-US", dateFormat: "12" };

type LocaleState = LocaleSettingsDto | "loading" | "failed";

function render(
  node: ReactNode,
  seed: (client: QueryClient) => void,
  locale: LocaleState = LA_24
): string {
  // retryOnMount off keeps a seeded failure visible; otherwise the first render re-pends it.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } }
  });
  if (locale === "failed") {
    client
      .getQueryCache()
      .build(client, { queryKey: queryKeys.settings.locale })
      .setState({ status: "error", error: new Error("down"), fetchStatus: "idle" });
  } else if (locale !== "loading") {
    client.setQueryData(queryKeys.settings.locale, { locale });
  }
  seed(client);
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(FeedbackProvider, null, node))
  );
}

/** The opening tag of the first element whose markup up to its close contains `text`. */
function tagAround(html: string, tag: string, text: string): string {
  const match = new RegExp(`<${tag}[^>]*>(?:(?!</${tag}>).)*${text}`, "s").exec(html);
  if (!match) throw new Error(`no <${tag}> containing ${text}`);
  return match[0].slice(0, match[0].indexOf(">") + 1);
}

function feedback(overrides: Partial<UsefulnessFeedbackDto>): UsefulnessFeedbackDto {
  return {
    id: "fb-1",
    ownerUserId: "user-1",
    targetKind: "news_story",
    targetRef: "news:1",
    surface: "news",
    kind: "more_like_this",
    sourceKind: null,
    sourceLabel: "Wire",
    priorityBand: null,
    effectKind: null,
    effectRef: null,
    metadata: { headline: "Story 1" },
    status: "active",
    reason: null,
    revision: 1,
    ruleVersion: null,
    createdAt: INSTANT,
    updatedAt: INSTANT,
    resolvedAt: null,
    ...overrides
  };
}

describe("settings timestamps use the person's zone and clock", () => {
  it("formats the shared settings timestamp in the person's locale", () => {
    expect(formatTimestamp(INSTANT, "fallback", LA_24)).toBe("Oct 9, 2026, 20:30");
    expect(formatTimestamp("not-a-date", "fallback", LA_24)).toBe("fallback");
  });

  it("reads the locale the app already loaded, and the shared default before it loads", () => {
    function Probe() {
      const locale = useUserLocale();
      return createElement("span", null, `${locale.timezone}|${locale.dateFormat}`);
    }
    const tokyo: LocaleSettingsDto = { timezone: "Asia/Tokyo", region: "en-US", dateFormat: "12" };
    const seeded = new QueryClient();
    seeded.setQueryData(["settings", "locale"], { locale: tokyo });
    expect(
      renderToString(createElement(QueryClientProvider, { client: seeded }, createElement(Probe)))
    ).toContain("Asia/Tokyo|12");
    expect(
      renderToString(
        createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe))
      )
    ).toContain("America/Los_Angeles|24");
  });

  it("shows an account's last sync in the admin oversight pane in the person's zone", () => {
    const account: ConnectorAccountDto = {
      id: "acct-1",
      providerId: "google-email",
      providerType: "google",
      providerDisplayName: "Google (Gmail + Calendar)",
      providerStatus: "available",
      ownerUserId: "user-1",
      scopes: ["gmail.readonly"],
      status: "active",
      hasSecret: true,
      revokedAt: null,
      createdAt: INSTANT,
      updatedAt: INSTANT,
      lastSyncStartedAt: INSTANT,
      lastSyncFinishedAt: INSTANT,
      lastSyncStatus: "success",
      lastSyncError: null,
      lastSyncCounts: null
    };
    const renderOversight = (locale: LocaleState) =>
      render(
        createElement(OversightPane),
        (client) =>
          client.setQueryData(queryKeys.settings.adminConnectorAccounts, { accounts: [account] }),
        locale
      );
    const html = renderOversight(LA_24);
    expect(html).toContain("Oct 9, 2026, 20:30");
    expect(html).not.toContain("Oct 10, 2026");
    expect(renderOversight(TOKYO_12)).toContain("Oct 10, 2026, 12:30 PM");
  });

  it("shows a data source's last sync in the person's zone", () => {
    expect(formatLastSync(INSTANT, LA_24)).toBe("Last sync: Oct 9, 2026, 20:30");
    expect(formatLastSync(INSTANT, LA_24, "boom")).toBe("Last sync failed: Oct 9, 2026, 20:30");
  });

  it("shows a news publisher's last check in the person's zone", () => {
    expect(lastCheckedLabel(INSTANT, LA_24)).toBe("Last checked Oct 9, 2026, 20:30");
  });

  it("shows a saved news story's date in the person's zone", () => {
    const renderNews = (locale: LocaleState) =>
      render(
        createElement(StoryFeedbackSettings),
        (client) => client.setQueryData(newsQueryKeys.feedback, { feedback: [feedback({})] }),
        locale
      );
    expect(renderNews(LA_24)).toContain("Oct 9, 2026, 20:30");
    expect(renderNews(TOKYO_12)).toContain("Oct 10, 2026, 12:30 PM");
  });

  it("shows a saved sports story's date in the person's zone", () => {
    const renderSports = (locale: LocaleState) =>
      render(
        createElement(StoryPreferencesSection),
        (client) =>
          client.setQueryData(["sports", "story-feedback"], {
            feedback: [feedback({ targetKind: "sports_story", surface: "sports" })]
          }),
        locale
      );
    const html = renderSports(LA_24);
    expect(html).toContain("Oct 9, 2026");
    expect(html).not.toContain("10/10/2026");
    expect(renderSports(TOKYO_12)).toContain("Oct 10, 2026");
  });

  it("shows when Backtrack last received text in the person's zone", () => {
    const html = render(createElement(BacktrackSettings), (client) => {
      client.setQueryData(["backtrack", "status"], {
        storage: "on",
        paused: false,
        macs: 1,
        days: 2,
        bytes: 2048,
        lastReceivedAt: INSTANT
      });
      client.setQueryData(["settings", "sessions"], { sessions: [] });
    });
    expect(html).toContain("Oct 9, 2026, 20:30");
  });
});

describe("Backtrack delete ranges use the person's day", () => {
  it("deletes from the person's midnight today, not the machine's", () => {
    expect(todayRange(NOW, LA_24.timezone)).toEqual({
      from: "2026-10-09T07:00:00.000Z",
      to: "2026-10-10T07:00:00.000Z"
    });
  });

  it("offers the person's today as the latest day to choose", () => {
    expect(todayDateValue(NOW, LA_24.timezone)).toBe("2026-10-09");
  });

  it("turns a chosen day into the person's midnight-to-midnight range", () => {
    expect(chosenDayRange("2026-10-04", LA_24.timezone)).toEqual({
      from: "2026-10-04T07:00:00.000Z",
      to: "2026-10-05T07:00:00.000Z"
    });
    expect(chosenDayRange("not-a-day", LA_24.timezone)).toBeUndefined();
  });

  it("titles the confirmation with the person's day", () => {
    expect(formatDay("2026-10-04T03:00:00.000Z", LA_24)).toBe("Saturday, October 3");
  });
});

describe("day deletes wait for the person's zone", () => {
  function renderBacktrack(locale: LocaleState): string {
    return render(
      createElement(BacktrackSettings),
      (client) => {
        client.setQueryData(["backtrack", "status"], {
          storage: "on",
          paused: false,
          macs: 1,
          days: 2,
          bytes: 2048,
          lastReceivedAt: INSTANT
        });
        client.setQueryData(["settings", "sessions"], { sessions: [] });
      },
      locale
    );
  }

  it("keeps Today and Choose a day off until the zone loads, and Last hour on", () => {
    const loading = renderBacktrack("loading");
    expect(tagAround(loading, "button", "Today")).toContain("disabled");
    expect(tagAround(loading, "button", "Choose a day")).toContain("disabled");
    expect(tagAround(loading, "button", "Last hour")).not.toContain("disabled");

    const loaded = renderBacktrack(LA_24);
    expect(tagAround(loaded, "button", "Today")).not.toContain("disabled");
    expect(tagAround(loaded, "button", "Choose a day")).not.toContain("disabled");
    expect(loaded).not.toContain("Could not load your time zone");
  });

  it("says so, and keeps day deletes off, when the zone fails to load", () => {
    const failed = renderBacktrack("failed");
    expect(failed).toContain("Could not load your time zone, so deleting by day is off.");
    expect(tagAround(failed, "button", "Today")).toContain("disabled");
  });
});

describe("other small screens use the person's day and zone", () => {
  it("starts the activity Today filter at the person's midnight", () => {
    expect(sinceForRange("today", LA_24.timezone, NOW)).toBe("2026-10-09T07:00:00.000Z");
    expect(sinceForRange("7d", LA_24.timezone, NOW)).toBe("2026-10-03T03:30:00.000Z");
  });

  it("defaults the wellness export to the 90 days up to the person's today", () => {
    expect(defaultExportRange(LA_24.timezone, NOW)).toEqual({
      from: "2026-07-11",
      to: "2026-10-09"
    });
  });

  it("saves a new or UTC-default digest in the person's zone and keeps an explicit choice", () => {
    expect(digestSaveTimezone(undefined, LA_24.timezone)).toBe("America/Los_Angeles");
    expect(digestSaveTimezone("UTC", LA_24.timezone)).toBe("America/Los_Angeles");
    expect(digestSaveTimezone("Europe/London", LA_24.timezone)).toBe("Europe/London");
  });

  it("keeps the stored digest zone when the person's zone failed to load", () => {
    expect(digestSaveTimezone("UTC", undefined)).toBe("UTC");
    expect(digestSaveTimezone("Asia/Tokyo", undefined)).toBe("Asia/Tokyo");
    expect(digestSaveTimezone(undefined, undefined)).toBe("America/Los_Angeles");
  });

  it("keeps the digest controls off until the person's zone loads", () => {
    const digest: GetNotificationDigestPreferenceResponse = {
      digest: {
        enabled: true,
        cadence: "daily",
        scheduleMetadata: { targetTime: "08:00", timezone: "UTC" },
        available: true,
        unavailableReason: null
      }
    };
    const renderDigest = (loaded: boolean) =>
      render(
        createElement(NotificationSettings, { onBack: () => undefined }),
        (client) => client.setQueryData(queryKeys.settings.notificationDigest, digest),
        loaded ? LA_24 : "loading"
      );
    const sendTime = (html: string) =>
      /<input[^>]*aria-label="Digest send time"[^>]*>/.exec(html)?.[0] ?? "";
    expect(sendTime(renderDigest(false))).toContain("disabled");
    expect(sendTime(renderDigest(true))).not.toContain("disabled");
    expect(sendTime(renderDigest(true))).toContain('value="08:00"');
  });

  it("keeps the briefing controls off until the person's zone loads", () => {
    const renderBriefings = (locale: LocaleState) =>
      render(
        createElement(BriefingSettings, { onBack: () => undefined }),
        (client) => {
          client.setQueryData(queryKeys.briefings.definitions, { definitions: [] });
          client.setQueryData(queryKeys.ai.assistantTools, { tools: [] });
          client.setQueryData(queryKeys.settings.sourceBehaviors, { sources: [] });
        },
        locale
      );
    const morningTime = (html: string) =>
      /<input[^>]*aria-label="Morning briefing time"[^>]*>/.exec(html)?.[0] ?? "";
    expect(morningTime(renderBriefings("loading"))).toContain("disabled");
    expect(morningTime(renderBriefings(LA_24))).not.toContain("disabled");
  });
});

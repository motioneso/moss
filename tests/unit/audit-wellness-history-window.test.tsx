// @vitest-environment jsdom
// Synthetic component evidence only; real API/RLS and live UI proof are separate gates.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { localDay, type CheckinDto } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { WellnessPage } from "../../apps/web/src/wellness/wellness-page.js";
import { WellnessHistory } from "../../apps/web/src/wellness/wellness-history.js";
import { WellnessTrends } from "../../apps/web/src/wellness/wellness-trends.js";
import {
  recentMoodAverage,
  localDayOffset,
  computeStreak
} from "../../apps/web/src/wellness/wellness-date-utils.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function entry(
  index: number,
  stamp = "2026-10-10T12:00:00.000Z",
  feelingCore: "happy" | "sad" = "happy"
): CheckinDto {
  return {
    id: `fictional-${index}`,
    ownerUserId: "fictional",
    checkedInAt: stamp,
    createdAt: stamp,
    feelingCore,
    feelingSecondary: "Fictional feeling",
    feelingTertiary: null,
    wheelVersion: "test",
    sensations: [],
    intensity: feelingCore === "happy" ? 1 : 5,
    energy: null,
    note: `Fictional note ${index}`,
    identifiedVia: "wheel"
  };
}
async function mount(
  content: React.ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
) {
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next: React.ReactNode) => {
    await act(async () =>
      root.render(<QueryClientProvider client={client}>{next}</QueryClientProvider>)
    );
  };
  await render(content);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  });
  return { host, render };
}
async function press(host: HTMLElement, name: string) {
  const control = Array.from(host.querySelectorAll<HTMLElement>("button, summary")).find(
    (button) => button.textContent?.trim() === name
  );
  expect(control).toBeDefined();
  await act(async () => control!.click());
}

describe("Wellness history traversal", () => {
  it("keeps independent loaded history visible and warns when a background refresh fails", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
    });
    const today = localDay(new Date(), "UTC");
    client.setQueryData(queryKeys.settings.locale, {
      locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
    });
    client.setQueryData([...queryKeys.wellness.checkins, "summary", today, "UTC"], {
      checkins: [],
      nextCursor: null
    });
    const key = [...queryKeys.wellness.checkins, "history"];
    client.setQueryData(key, {
      pages: [{ checkins: [entry(1)], nextCursor: null }],
      pageParams: [undefined]
    });
    client
      .getQueryCache()
      .find({ queryKey: key, exact: true })!
      .setState({ status: "error", error: new Error("refresh failed"), fetchStatus: "idle" });
    const html = renderToString(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WellnessPage />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(html).toContain("Could not refresh check-in history");
    expect(html).toContain("checkin-fictional-1");
    expect(html).toContain("Mood · 14 completed days");
    expect(html).toContain("Streak · through yesterday");
    client.clear();
  });
  it("exposes corrections past fifty rows and keeps loaded entries during older-page failure", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => entry(index));
    let loadCount = 0;
    let edited: string | undefined;
    const history = (error = false) => (
      <WellnessHistory
        checkins={rows}
        hasMore
        loadMoreError={error}
        onLoadMore={() => {
          loadCount++;
        }}
        onClearFilter={() => {}}
        onEdit={(id) => {
          edited = id;
        }}
        timezone="UTC"
      />
    );
    const { host, render } = await mount(history());
    while (!host.querySelector('[aria-controls="checkin-fictional-59"]')) {
      const more = Array.from(host.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Show ")
      )!;
      await act(async () => more.click());
    }
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-controls="checkin-fictional-59"]')!.click()
    );
    await press(host, "Edit");
    expect(edited).toBe("fictional-59");
    await press(host, "Load older check-ins");
    expect(loadCount).toBe(1);
    await render(history(true));
    expect(host.textContent).toContain("Your loaded entries are still here");
    expect(host.querySelector('[aria-controls="checkin-fictional-59"]')).not.toBeNull();
    await press(host, "Retry older entries");
    expect(loadCount).toBe(2);
  });
  it("keeps searching older pages when the currently loaded rows do not match a filter", async () => {
    let loads = 0;
    const { host } = await mount(
      <WellnessHistory
        checkins={[entry(0)]}
        filter="notes"
        hasMore
        onLoadMore={() => {
          loads++;
        }}
        onClearFilter={() => {}}
        onEdit={() => {}}
      />
    );
    expect(host.textContent).toContain("No matching check-ins in the loaded entries");
    await press(host, "Load older check-ins");
    expect(loads).toBe(1);
  });
});

describe("Wellness complete-window statistics", () => {
  it("uses all 620 observations in the selected chart day and completed-day average", async () => {
    const today = localDay(new Date(), "UTC");
    const rows = Array.from({ length: 620 }, (_, index) =>
      entry(index, `${today}T12:00:00.000Z`, index < 500 ? "happy" : "sad")
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    client.setQueryData([...queryKeys.wellness.checkins, "window", 30, today, "UTC"], {
      checkins: rows,
      nextCursor: null
    });
    client.setQueryData(queryKeys.wellness.adherenceSummary(30), { days: [] });
    const { host } = await mount(<WellnessTrends />, client);
    await press(host, "View daily values");
    const row = Array.from(host.querySelectorAll("tr")).find(
      (row) => row.querySelector("th")?.textContent === today
    )!;
    expect(row.querySelector("td")?.textContent).toBe("-0.2");
    const completed = rows.map((row) => ({
      ...row,
      checkedInAt: `${localDayOffset(1, "UTC")}T12:00:00Z`
    }));
    expect(recentMoodAverage(completed, "UTC")).toBe(-0.2);
    expect(computeStreak(completed, "UTC")).toBe(1);
  });
  it("does not fabricate daily chart values when the complete-window read failed", async () => {
    const today = localDay(new Date(), "UTC");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } }
    });
    client
      .getQueryCache()
      .build(client, { queryKey: [...queryKeys.wellness.checkins, "window", 30, today, "UTC"] })
      .setState({ status: "error", error: new Error("Second page failed"), fetchStatus: "idle" });
    client.setQueryData(queryKeys.wellness.adherenceSummary(30), { days: [] });
    const { host } = await mount(<WellnessTrends />, client);
    expect(host.textContent).toContain("Trend data unavailable");
    expect(host.textContent).toContain("Try again");
    expect(host.textContent).not.toContain("View daily values");
  });
});

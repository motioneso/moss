// @vitest-environment jsdom
// Synthetic component checks; rendered browser acceptance remains a separate step.
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsefulnessFeedbackDto } from "@moss/shared";
import * as api from "../../apps/web/src/api/client.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { GoalsSection } from "../../apps/web/src/today/goals-section.js";
import { WellnessChart, type DayPoint } from "../../apps/web/src/wellness/wellness-chart.js";
import { WellnessTrends } from "../../apps/web/src/wellness/wellness-trends.js";
import SportsSettings from "../../packages/sports/src/settings/index.js";
import { StoryPreferencesSection } from "../../packages/sports/src/settings/story-preferences.js";
import * as sportsApi from "../../packages/sports/src/web/sports-client.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";

vi.mock("../../apps/web/src/api/client.js", async (original) => ({
  ...(await original<typeof api>()),
  listWellnessCheckinsInWindow: vi.fn(),
  getMedicationAdherenceSummary: vi.fn(),
  listGoals: vi.fn()
}));
vi.mock("../../packages/sports/src/web/sports-client.js", async (original) => ({
  ...(await original<typeof sportsApi>()),
  listSportsStoryFeedback: vi.fn(),
  updateSportsStoryFeedbackReason: vi.fn(),
  undoSportsStoryFeedback: vi.fn()
}));

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function makeClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } }
  });
  client.setQueryData(queryKeys.settings.locale, {
    locale: { timezone: "UTC", region: "en-US", dateFormat: "24" }
  });
  return client;
}

async function mount(content: ReactNode, client = makeClient()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{content}</QueryClientProvider>)
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });
  return { host, client };
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

function loadTrends() {
  vi.mocked(api.listWellnessCheckinsInWindow).mockResolvedValue({ checkins: [] });
  vi.mocked(api.getMedicationAdherenceSummary).mockResolvedValue({ days: [] });
}

describe("Wellness Trends states", () => {
  it("announces exactly one initial loading status and no missing-data chart", async () => {
    vi.mocked(api.listWellnessCheckinsInWindow).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.getMedicationAdherenceSummary).mockReturnValue(new Promise(() => {}));
    const { host } = await mount(<WellnessTrends />);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual([
      "Loading trend data…"
    ]);
    expect(host.querySelector(".wl-chartcard")).toBeNull();
  });

  it("distinguishes a first-read error and lets retry load the chart", async () => {
    vi.mocked(api.listWellnessCheckinsInWindow).mockRejectedValue(new Error("offline"));
    vi.mocked(api.getMedicationAdherenceSummary).mockResolvedValue({ days: [] });
    const { host } = await mount(<WellnessTrends />);
    await vi.waitFor(() => expect(host.textContent).toContain("Couldn't load trend data."));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.textContent).not.toContain("refresh");
    expect(host.querySelector(".wl-chartcard")).toBeNull();
    loadTrends();
    await act(async () => button(host, "Try again").click());
    await vi.waitFor(() => expect(host.querySelector(".wl-chart__canvas")).not.toBeNull());
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("retains the last loaded chart and names it when a refresh fails", async () => {
    loadTrends();
    const { host, client } = await mount(<WellnessTrends />);
    await vi.waitFor(() => expect(host.querySelector(".wl-chart__canvas")).not.toBeNull());
    vi.mocked(api.listWellnessCheckinsInWindow).mockRejectedValue(new Error("offline"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.wellness.checkins });
    });
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        "Couldn't refresh trend data. Showing the last loaded data."
      )
    );
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector(".wl-chart__canvas")).not.toBeNull();
    expect(host.querySelectorAll("tbody tr")).toHaveLength(30);
    expect(button(host, "Try again")).toBeDefined();
  });

  it("keeps day selection and daily values accessible alongside the scrollable plot", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.classList.contains("wl-chart__canvas") ? 760 : 300;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(229);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
    const day: DayPoint = {
      date: "2026-10-15",
      label: "October 15 with a long localized month label",
      isToday: false,
      checkin: null,
      checkins: [],
      medFrac: 0.5,
      medTaken: 1,
      medDenom: 2
    };
    const { host } = await mount(<WellnessChart days={[day]} />);
    const plot = host.querySelector<HTMLElement>('[role="region"]')!;
    expect(plot.tabIndex).toBe(0);
    expect(plot.getAttribute("aria-label")).toBe("Mood and medication chart");
    expect(plot.querySelector(".wl-chart__canvas svg")?.getAttribute("viewBox")).toMatch(
      /^0 0 760 /
    );
    expect(host.querySelector("caption")?.textContent).toBe("Mood and medication observations");
    const selector = host.querySelector("select")!;
    expect(host.querySelector("label")?.htmlFor).toBe(selector.id);
    await act(async () => {
      selector.value = "0";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "2026-10-15. No check-in. Medication: 1 of 2 taken."
    );
    expect(host.querySelector("tbody")?.textContent).toContain("1 of 2");
    const tip = host.querySelector<HTMLElement>(".wl-chart__tip")!;
    expect(parseFloat(tip.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(tip.style.left) + tip.offsetWidth).toBeLessThanOrEqual(760);
    expect(parseFloat(tip.style.top)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(tip.style.top) + tip.offsetHeight).toBeLessThanOrEqual(229);
    expect(plot.scrollLeft).toBeGreaterThan(0);
    expect(plot.scrollLeft).toBeLessThan(760 - plot.clientWidth);
    await act(async () => {
      host.querySelector("summary")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("2026-10-15");
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe("Today goals semantics", () => {
  it("omits the section while goals are loading", async () => {
    vi.mocked(api.listGoals).mockReturnValue(new Promise(() => {}));
    const { host } = await mount(<GoalsSection />);
    expect(host.querySelector("section")).toBeNull();
  });

  it("labels the section with its unchanged smaller heading role", async () => {
    const client = makeClient();
    client.setQueryData(queryKeys.goals.list, [
      { id: "active", title: "Learn a language", status: "active", desiredOutcome: "Read a novel" },
      { id: "done", title: "Finished goal", status: "completed" }
    ]);
    const { host } = await mount(<GoalsSection />, client);
    const heading = host.querySelector("h2.jds-brief__title")!;
    expect(heading.textContent?.trim()).toBe("Long-term goals");
    expect(host.querySelector("section")?.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(host.textContent).toContain("Focus");
    expect(host.textContent).not.toContain("Finished goal");
  });

  it.each([
    { goals: [] },
    { goals: [{ id: "done", title: "Finished goal", status: "completed" }] }
  ])("omits the section without active goals (%j)", async ({ goals }) => {
    const client = makeClient();
    client.setQueryData(queryKeys.goals.list, goals);
    const { host } = await mount(<GoalsSection />, client);
    expect(host.querySelector("section")).toBeNull();
  });
});

const preference: UsefulnessFeedbackDto = {
  id: "sports-preference",
  ownerUserId: "fictional-owner",
  targetKind: "sports_story",
  targetRef: "fictional-story",
  surface: "sports",
  kind: "less_like_this",
  sourceKind: null,
  sourceLabel: null,
  priorityBand: null,
  effectKind: null,
  effectRef: null,
  metadata: { headline: "A long sports headline", sourceLabel: "Example Sports" },
  status: "active",
  reason: "Already read this story",
  revision: 1,
  ruleVersion: 1,
  createdAt: "2026-10-15T12:00:00Z",
  updatedAt: "2026-10-15T12:00:00Z",
  resolvedAt: null
};

function sportsClient() {
  const client = makeClient();
  client.setQueryData(["sports", "story-feedback"], { feedback: [preference] });
  return client;
}

describe("Sports settings authored roles", () => {
  it("uses one shared h3 title role for siblings beneath the pane heading", async () => {
    const client = sportsClient();
    client.setQueryData(sportsQueryKeys.catalog, { competitions: [], degraded: false });
    client.setQueryData(sportsQueryKeys.follows, { follows: [] });
    client.setQueryData(sportsQueryKeys.sources, { sources: [] });
    client.setQueryData(sportsQueryKeys.standingsPreferences, {
      configuredCompetitionKeys: [],
      lastViewed: null
    });
    const { host } = await mount(<SportsSettings />, client);
    expect([...host.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Sports"
    ]);
    const headings = [...host.querySelectorAll("h3.jds-section-head__title")];
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Following",
      "News sources",
      "Story preferences",
      "Configure standings0 of 0"
    ]);
  });

  it("keeps editing, validation and removal behavior on shared controls", async () => {
    vi.mocked(sportsApi.listSportsStoryFeedback).mockResolvedValue({ feedback: [preference] });
    vi.mocked(sportsApi.updateSportsStoryFeedbackReason).mockResolvedValue({
      feedback: preference
    });
    vi.mocked(sportsApi.undoSportsStoryFeedback).mockResolvedValue({ feedback: preference });
    const { host } = await mount(<StoryPreferencesSection />, sportsClient());
    expect(host.querySelector("time")?.className).toBe("jds-caption");
    await act(async () => button(host, "Edit reason").click());
    const textarea = host.querySelector("textarea")!;
    expect(textarea.className).toBe("jds-textarea");
    expect(textarea.closest(".jds-field")).not.toBeNull();
    expect(host.querySelector("label")?.htmlFor).toBe(textarea.id);
    expect(host.querySelector("label")?.textContent).toBe("Reason for A long sports headline");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, "   ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button(host, "Save").disabled).toBe(true);
    await act(async () => {
      setValue.call(textarea, "  Already read it elsewhere  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      [...host.querySelectorAll("button")].every((element) => element.classList.contains("jds-btn"))
    ).toBe(true);
    await act(async () => button(host, "Save").click());
    await vi.waitFor(() =>
      expect(sportsApi.updateSportsStoryFeedbackReason).toHaveBeenCalledWith(preference.id, {
        reason: "Already read it elsewhere"
      })
    );
    await vi.waitFor(() => expect(host.querySelector("textarea")).toBeNull());
    await act(async () => button(host, "Remove").click());
    await vi.waitFor(() =>
      expect(sportsApi.undoSportsStoryFeedback).toHaveBeenCalledWith(preference.id)
    );
  });
});

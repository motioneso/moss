// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompetitionRef, SportsFollowDto } from "@moss/shared";

import {
  buildStandingsPickerGroups,
  StandingsPicker
} from "../../packages/sports/src/web/sports-standings-picker.js";
import { StandingsLeaguesSection } from "../../packages/sports/src/settings/index.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG: readonly CompetitionRef[] = [
  {
    competitionKey: "nfl",
    label: "NFL",
    sportLabel: "Football",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    confederation: "INTL"
  },
  {
    competitionKey: "nba",
    label: "NBA",
    sportLabel: "Basketball",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    confederation: "INTL"
  },
  {
    competitionKey: "eng.1",
    label: "Premier League",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    confederation: "UEFA"
  }
];

const FOLLOWS: readonly SportsFollowDto[] = [
  {
    id: "1",
    competitionKey: "nba",
    teamKey: "lal",
    createdAt: "2026-08-29T12:00:00.000Z"
  },
  {
    id: "2",
    competitionKey: "nba",
    teamKey: null,
    createdAt: "2026-08-28T12:00:00.000Z"
  }
];

describe("standings picker", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  async function renderSettings(client: QueryClient) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <StandingsLeaguesSection competitions={CATALOG} />
        </QueryClientProvider>
      )
    );
  }

  it("builds Following first, deduplicates follows, preserves catalog order and region depth", () => {
    const groups = buildStandingsPickerGroups(CATALOG, FOLLOWS, ["eng.1", "nfl", "retired"]);
    expect(groups.map((group) => group.label)).toEqual(["Following", "Football", "Soccer"]);
    expect(
      groups[0]?.regions[0]?.competitions.map((competition) => competition.competitionKey)
    ).toEqual(["nba"]);
    expect(groups[2]?.regions[0]).toMatchObject({ label: "England" });
    expect(buildStandingsPickerGroups(CATALOG, [], [])).toEqual([]);
  });

  it("opens, moves, selects and dismisses by keyboard or outside click with focus return", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    function Harness() {
      const [value, setValue] = useState("nba");
      return (
        <StandingsPicker
          catalog={CATALOG}
          follows={FOLLOWS}
          selectedCompetitionKeys={["nfl", "eng.1"]}
          value={value}
          onChange={setValue}
        />
      );
    }
    await act(async () => root?.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>(
      "[aria-label='Select standings league']"
    )!;
    expect(trigger.textContent).toBe("NBA");

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(container.textContent).toContain("Following");
    expect(container.textContent).toContain("England");
    expect(document.activeElement?.textContent).toBe("NBA");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(document.activeElement?.textContent).toBe("NFL");
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(trigger.textContent).toBe("NFL");
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => trigger.click());
    await act(async () =>
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    );
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("disables standings settings until a replacement save is confirmed", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sportsQueryKeys.standingsPreferences, {
      selectedCompetitionKeys: ["nfl"]
    });
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pending)
    );
    await renderSettings(client);
    const nfl = container!.querySelector<HTMLInputElement>("input")!;
    await act(async () => nfl.click());
    await vi.waitFor(() =>
      expect(
        container!.querySelector(".sp-standings-settings__choices")?.getAttribute("aria-disabled")
      ).toBe("true")
    );
    await act(async () => {
      resolve(
        new Response(JSON.stringify({ selectedCompetitionKeys: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
      await pending;
      await vi.waitFor(() =>
        expect(
          container!.querySelector(".sp-standings-settings__choices")?.getAttribute("aria-disabled")
        ).toBe("false")
      );
    });
    expect(client.getQueryData(sportsQueryKeys.standingsPreferences)).toEqual({
      selectedCompetitionKeys: []
    });
  });

  it("keeps the confirmed standings selection after a failed save", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sportsQueryKeys.standingsPreferences, {
      selectedCompetitionKeys: ["nfl"]
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "save failed" }), {
            status: 500,
            headers: { "content-type": "application/json" }
          })
      )
    );
    await renderSettings(client);
    await act(async () => {
      container!.querySelector<HTMLInputElement>("input")!.click();
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(container!.querySelector("[role='alert']")?.textContent).toContain(
      "last saved selection is unchanged"
    );
    expect(container!.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
    expect(client.getQueryData(sportsQueryKeys.standingsPreferences)).toEqual({
      selectedCompetitionKeys: ["nfl"]
    });
  });
});

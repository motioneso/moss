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
    expect(container.textContent).not.toContain("England");
    expect(document.activeElement?.textContent).toBe("NBA");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      );
    });
    expect(document.activeElement?.textContent).toBe("Football");
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
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

  it("drills from followed leagues and sports into regions and leagues", async () => {
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

    await act(async () => trigger.click());
    expect(container.textContent).toContain("Following");
    expect(container.textContent).not.toContain("NFL");
    expect(container.textContent).toContain("Soccer");
    expect(container.textContent).not.toContain("England");
    expect(container.textContent).not.toContain("Premier League");

    await act(async () =>
      Array.from(container!.querySelectorAll("button"))
        .find((button) => button.textContent === "Soccer")!
        .click()
    );
    expect(container.textContent).toContain("England");
    expect(container.textContent).not.toContain("Premier League");

    await act(async () =>
      Array.from(container!.querySelectorAll("button"))
        .find((button) => button.textContent === "England")!
        .click()
    );
    expect(container.textContent).toContain("Premier League");

    await act(async () =>
      Array.from(container!.querySelectorAll("button"))
        .find((button) => button.textContent === "Premier League")!
        .click()
    );
    expect(trigger.textContent).toBe("Premier League");
    expect(document.activeElement).toBe(trigger);
  });

  function openPanel() {
    return act(async () =>
      container!.querySelector<HTMLButtonElement>("button.sp-standings-settings__toggle")!.click()
    );
  }

  function leagueBox(label: string): HTMLInputElement {
    const box = Array.from(
      container!.querySelectorAll<HTMLLabelElement>("label.sp-standings-tree__check")
    ).find((entry) => entry.textContent === label);
    return box!.querySelector<HTMLInputElement>("input[type='checkbox']")!;
  }

  it("disables standings settings until a replacement save is confirmed", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
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
    await openPanel();
    await act(async () => leagueBox("NFL").click());
    await vi.waitFor(() =>
      expect(container!.querySelector(".sp-standings-tree")?.getAttribute("aria-disabled")).toBe(
        "true"
      )
    );
    expect(leagueBox("NBA").disabled).toBe(true);
    await act(async () => {
      resolve(
        new Response(JSON.stringify({ selectedCompetitionKeys: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
      await pending;
      await vi.waitFor(() =>
        expect(container!.querySelector(".sp-standings-tree")?.getAttribute("aria-disabled")).toBe(
          "false"
        )
      );
    });
    expect(client.getQueryData(sportsQueryKeys.standingsPreferences)).toEqual({
      selectedCompetitionKeys: []
    });
  });

  it("curates standings with a grouped checklist and saves on each tick", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    client.setQueryData(sportsQueryKeys.standingsPreferences, {
      selectedCompetitionKeys: ["nfl"]
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ selectedCompetitionKeys: ["nfl", "eng.1"] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );
    await renderSettings(client);
    expect(container!.querySelector("select")).toBeNull();
    // Collapsed by default: the header carries the count, the checklist is hidden.
    expect(container!.querySelector(".sp-standings-settings__toggle")?.textContent).toContain(
      "1 of 3"
    );
    expect(container!.querySelector<HTMLElement>("#sp-standings-settings-panel")?.hidden).toBe(
      true
    );
    await openPanel();
    expect(leagueBox("NFL").checked).toBe(true);
    expect(leagueBox("NBA").checked).toBe(false);
    // Sports collapse like countries do (Ben, 2026-09-04): open Soccer, then England.
    expect(container!.textContent).toContain("England");
    const englandLeagues = () =>
      container!.querySelector<HTMLElement>("#sp-standings-region-soccer-england");
    expect(container!.querySelector<HTMLElement>("#sp-standings-sport-soccer")?.hidden).toBe(true);
    expect(englandLeagues()?.hidden).toBe(true);
    for (const label of ["Soccer", "England"]) {
      await act(async () =>
        Array.from(container!.querySelectorAll("button"))
          .find((button) => button.textContent?.includes(label))!
          .click()
      );
    }
    expect(container!.querySelector<HTMLElement>("#sp-standings-sport-soccer")?.hidden).toBe(false);
    expect(englandLeagues()?.hidden).toBe(false);
    expect(leagueBox("Premier League").checked).toBe(false);

    await act(async () => {
      leagueBox("Premier League").click();
      await vi.waitFor(() =>
        expect(client.getQueryData(sportsQueryKeys.standingsPreferences)).toEqual({
          selectedCompetitionKeys: ["nfl", "eng.1"]
        })
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(leagueBox("Premier League").checked).toBe(true);
  });

  it("keeps the confirmed standings selection after a failed save", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
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
    await openPanel();
    await act(async () => {
      leagueBox("NFL").click();
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(container!.querySelector("[role='alert']")?.textContent).toContain(
      "last saved selection is unchanged"
    );
    expect(leagueBox("NFL").checked).toBe(true);
    expect(leagueBox("NBA").checked).toBe(false);
    expect(client.getQueryData(sportsQueryKeys.standingsPreferences)).toEqual({
      selectedCompetitionKeys: ["nfl"]
    });
  });
});

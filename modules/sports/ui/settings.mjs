/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { h, button } from "./dom.mjs";
import { note } from "./settings-ui.mjs";
import { settingsApi } from "./settings-api.mjs";
import { mountFollows } from "./follows.mjs";
import { mountSources } from "./sources.mjs";
import { mountStandingsSettings } from "./standings-settings.mjs";

/** Shared lists the three sections read. Rosters load for every league that has a followed team. */
export function mountSettings({ root, api }) {
  const store = {
    competitions: [],
    competitionsByKey: new Map(),
    follows: [],
    teamsByCompetition: new Map(),
    reloadFollows: async () => {
      store.follows = (await api.follows()).follows ?? [];
      await loadRosters();
      repaintAll();
    }
  };
  let failed = false;
  let sections = null;

  const status = h("div", {});
  const body = h("div", {});
  root.replaceChildren(
    h(
      "div",
      { class: "pane__head" },
      h("h1", { class: "pane__title" }, "Sports"),
      h(
        "p",
        { class: "pane__desc" },
        "Choose what you follow, where your sports news comes from, and which standings you can browse."
      )
    ),
    status,
    body
  );

  async function loadRosters() {
    const keys = new Set(
      store.follows.filter((f) => f.teamKey !== null).map((f) => f.competitionKey)
    );
    await Promise.all(
      [...keys]
        .filter((key) => !store.teamsByCompetition.has(key))
        .map(async (key) => {
          try {
            store.teamsByCompetition.set(key, (await api.leagueTeams(key)).teams ?? []);
          } catch {
            /* chips fall back to the saved team key */
          }
        })
    );
  }

  function repaintAll() {
    if (!sections) return;
    sections.follows.repaint();
    sections.sources.repaint();
  }

  function paintStatus() {
    status.replaceChildren();
    if (failed) {
      status.append(
        note(
          "Could not load sports follows. Try again. ",
          button("Retry", { variant: "secondary", size: "sm", onClick: load })
        )
      );
    }
  }

  async function load() {
    failed = false;
    try {
      const [catalog, follows] = await Promise.all([api.catalog(), api.follows()]);
      store.competitions = catalog.competitions ?? [];
      store.competitionsByKey = new Map(store.competitions.map((c) => [c.competitionKey, c]));
      store.follows = follows.follows ?? [];
    } catch {
      failed = true;
    }
    paintStatus();
    if (failed) return;
    if (!sections) {
      sections = {
        follows: mountFollows({ api, store }),
        sources: mountSources({ api, store }),
        standings: mountStandingsSettings({ api, store })
      };
      body.append(sections.follows.el, sections.sources.el, sections.standings.el);
    } else {
      repaintAll();
      sections.standings.repaint();
    }
    await loadRosters();
    repaintAll();
  }

  load();
  return { store };
}

if (typeof document !== "undefined" && document.getElementById("root")) {
  mountSettings({ root: document.getElementById("root"), api: settingsApi(moduleClient()) });
}

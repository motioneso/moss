/* global document */
import { h, button, clear } from "./dom.mjs";
import { badge, chevron, check, disclosure, note } from "./settings-ui.mjs";
import { groupCompetitions, slug } from "./settings-logic.mjs";

const TITLE_ID = "sp-standings-settings-title";
const PANEL_ID = "sp-standings-settings-panel";

/**
 * The "Configure standings" block. It starts closed. Every change saves the whole selection and
 * leaves the last saved choice in place when the save fails.
 */
export function mountStandingsSettings({ api, store }) {
  let open = false;
  let saved = undefined; // undefined while loading, null when never chosen, else the saved keys
  let loadFailed = false;
  let saving = false;
  let saveFailed = false;
  const opened = new Set();

  const root = h("section", { class: "sp-standings-settings", "aria-labelledby": TITLE_ID });
  const head = h("div", { class: "sp-standings-settings__head" });
  const panel = h("div", { id: PANEL_ID, class: "sp-standings-settings__panel" });
  root.append(head, panel);

  const all = () => store.competitions;
  const selectedSet = () =>
    new Set(saved === null || saved === undefined ? all().map((c) => c.competitionKey) : saved);
  const disabled = () => saved === undefined || saving;

  async function save(next) {
    saving = true;
    saveFailed = false;
    paint();
    try {
      const keys = all()
        .map((c) => c.competitionKey)
        .filter((key) => next.has(key));
      const reply = await api.saveStandingsLeagues(keys);
      saved = reply.selectedCompetitionKeys ?? keys;
    } catch {
      saveFailed = true;
    }
    saving = false;
    paint();
  }

  function toggleLeague(key, checked) {
    const next = selectedSet();
    if (checked) next.add(key);
    else next.delete(key);
    save(next);
  }

  function toggleGroup(competitions, allChosen) {
    const next = selectedSet();
    for (const c of competitions) {
      if (allChosen) next.delete(c.competitionKey);
      else next.add(c.competitionKey);
    }
    save(next);
  }

  function leagueCheck(competition, selected) {
    return check({
      id: `sp-standings-league-${slug(competition.competitionKey)}`,
      label: h("span", {}, competition.label),
      checked: selected.has(competition.competitionKey),
      disabled: disabled(),
      className: "sp-standings-tree__check sp-standings-tree__league",
      onChange: (checked) => toggleLeague(competition.competitionKey, checked)
    }).el;
  }

  function groupRow({ id, label, ariaLabel, competitions, selected, isSport }) {
    const chosen = competitions.filter((c) => selected.has(c.competitionKey));
    const every = chosen.length === competitions.length;
    const expanded = opened.has(id);
    const box = check({
      id: `${id}-all`,
      ariaLabel,
      checked: every,
      disabled: disabled(),
      className: "sp-standings-tree__check",
      onChange: () => toggleGroup(competitions, every)
    });
    box.input.indeterminate = chosen.length > 0 && !every;
    return {
      expanded,
      row: h(
        "div",
        { class: "sp-standings-tree__row" },
        box.el,
        disclosure(
          {
            id: `${id}-toggle`,
            className: "sp-standings-tree__toggle",
            expanded,
            controls: id,
            onClick: () => {
              if (opened.has(id)) opened.delete(id);
              else opened.add(id);
              paint();
            }
          },
          chevron(expanded),
          h("span", { class: isSport ? "sp-standings-tree__sport-label" : "" }, label),
          badge(`${chosen.length} of ${competitions.length}`, "steel")
        )
      )
    };
  }

  function tree(selected) {
    const wrap = h("div", {
      class: "sp-standings-tree",
      role: "group",
      "aria-labelledby": TITLE_ID,
      "aria-disabled": String(disabled()),
      "aria-busy": String(saving)
    });
    wrap.append(
      h(
        "div",
        { class: "sp-standings-tree__toolbar" },
        button("Select all", {
          variant: "secondary",
          size: "sm",
          disabled: disabled() || selected.size === all().length,
          onClick: () => save(new Set(all().map((c) => c.competitionKey)))
        }),
        button("Clear all", {
          variant: "secondary",
          size: "sm",
          disabled: disabled() || selected.size === 0,
          onClick: () => save(new Set())
        })
      )
    );
    for (const sport of groupCompetitions(all())) {
      const sportCompetitions = [...sport.leagues, ...sport.regions.flatMap((r) => r.competitions)];
      const sportId = `sp-standings-sport-${slug(sport.label)}`;
      const top = groupRow({
        id: sportId,
        label: sport.label,
        ariaLabel: `All ${sport.label} leagues`,
        competitions: sportCompetitions,
        selected,
        isSport: true
      });
      const leagues = h("div", { id: sportId, class: "sp-standings-tree__leagues" });
      leagues.hidden = !top.expanded;
      for (const c of sport.leagues) leagues.append(leagueCheck(c, selected));
      for (const region of sport.regions) {
        const regionId = `sp-standings-region-${slug(sport.label)}-${slug(region.label)}`;
        const inner = groupRow({
          id: regionId,
          label: region.label,
          ariaLabel: `All ${region.label} leagues`,
          competitions: region.competitions,
          selected
        });
        const list = h("div", { id: regionId, class: "sp-standings-tree__leagues" });
        list.hidden = !inner.expanded;
        for (const c of region.competitions) list.append(leagueCheck(c, selected));
        leagues.append(h("div", { class: "sp-standings-tree__region" }, inner.row, list));
      }
      wrap.append(h("div", { class: "sp-standings-tree__sport" }, top.row, leagues));
    }
    if (saving)
      wrap.append(h("span", { class: "jds-hint", role: "status" }, "Saving league choices…"));
    return wrap;
  }

  function paint() {
    const focusId = document.activeElement?.id;
    paintNow();
    if (focusId) document.getElementById(focusId)?.focus();
  }

  function paintNow() {
    const selected = selectedSet();
    const chosen = all().filter((c) => selected.has(c.competitionKey));
    clear(head);
    head.append(
      h(
        "div",
        { class: "jds-section-head" },
        h(
          "h3",
          { class: "jds-section-head__title", id: TITLE_ID },
          disclosure(
            {
              id: "sp-standings-settings-toggle",
              className: "sp-standings-settings__toggle",
              expanded: open,
              controls: PANEL_ID,
              onClick: () => {
                open = !open;
                paint();
              }
            },
            chevron(open),
            h("span", {}, "Configure standings"),
            badge(`${chosen.length} of ${all().length}`, "steel")
          )
        )
      ),
      note("Choose the leagues available in the Sports standings picker.")
    );
    if (!open && chosen.length > 0) {
      head.append(
        h(
          "p",
          { class: "sp-standings-settings__preview", "aria-hidden": "true" },
          chosen.slice(0, 6).map((c) => badge(c.label, "neutral", true)),
          chosen.length > 6 ? h("span", { class: "jds-hint" }, `+${chosen.length - 6} more`) : null
        )
      );
    }
    panel.hidden = !open;
    clear(panel);
    if (loadFailed) panel.append(note("Could not load standings leagues. Try again."));
    if (saveFailed) {
      panel.append(
        h(
          "p",
          { role: "alert" },
          "Could not save standings leagues. Your last saved selection is unchanged."
        )
      );
    }
    panel.append(tree(selected));
  }

  async function load() {
    try {
      const reply = await api.standingsPreferences();
      saved = reply.selectedCompetitionKeys ?? null;
      loadFailed = false;
    } catch {
      loadFailed = true;
      saved = null;
    }
    paint();
  }

  paint();
  load();
  return { el: root, repaint: paint };
}

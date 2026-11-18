import { clear, h } from "./dom.mjs";
import { isFollowed } from "./ranking.mjs";
import { formatDate, formatTime } from "./locale.mjs";
import { buildStandingsPickerGroups, standingsPicker } from "./picker.mjs";
import { SETTINGS_PATH } from "./ticker.mjs";
import { trophyIcon } from "./parts.mjs";

/** A pickable view of a standings table: the whole league, a conference, or one division. */
export function buildViews(sections) {
  if (sections.length === 0) return [];
  const all = { key: "all", label: "All", conference: null, sections };
  const hasConference = sections.some((s) => s.conference);
  if (!hasConference) {
    if (sections.length === 1) return [all];
    return [all, ...sections.map((section, index) => ({ key: `sec:${index}`, label: section.label ?? `Group ${index + 1}`, conference: null, sections: [section] }))];
  }
  const order = [];
  const byConference = new Map();
  sections.forEach((section, index) => {
    const conference = section.conference ?? "";
    if (!byConference.has(conference)) {
      byConference.set(conference, []);
      order.push(conference);
    }
    byConference.get(conference).push({ section, index });
  });
  const views = [all];
  for (const conference of order) {
    const members = byConference.get(conference) ?? [];
    if (conference) views.push({ key: `conf:${conference}`, label: conference, conference, sections: members.map((m) => m.section) });
    for (const { section, index } of members) {
      views.push({ key: `sec:${index}`, label: section.label ?? `Group ${index + 1}`, conference: conference || null, sections: [section] });
    }
  }
  return views;
}

function defaultViewKey(views, competitionKey, followed) {
  if (views.some((v) => v.key.startsWith("conf:"))) {
    const sections = views.filter((v) => v.key.startsWith("sec:"));
    const mine = sections.find((v) => v.sections[0]?.rows.some((row) => isFollowed(followed, competitionKey, row.sourceTeamId)));
    if (mine) return mine.key;
    const alphabetical = [...sections].sort((a, b) => a.label.localeCompare(b.label));
    return alphabetical[0]?.key ?? "all";
  }
  return "all";
}

export function defaultStandingsKey(groups, visibleKeys, activeKeys, catalog) {
  const active = new Set(activeKeys);
  const kind = (key) => catalog.find((c) => c.competitionKey === key)?.kind;
  const inactiveTournament = (key) => kind(key) === "tournament" && !active.has(key);
  return (
    groups.find((g) => visibleKeys.includes(g.competitionKey) && !inactiveTournament(g.competitionKey))?.competitionKey ??
    visibleKeys.find((key) => !inactiveTournament(key)) ??
    visibleKeys[0] ??
    ""
  );
}

export function resolveDefaultStandingsKey(remembered, groups, visibleKeys, activeKeys, catalog) {
  if (remembered && visibleKeys.includes(remembered)) return remembered;
  return defaultStandingsKey(groups, visibleKeys, activeKeys, catalog);
}

export function resolveStandingsViewKey(remembered, views, fallbackKey) {
  if (!remembered) return fallbackKey;
  if (remembered.viewLabel && remembered.viewLabel !== "All") {
    const byLabel = views.find((v) => v.label === remembered.viewLabel);
    if (byLabel) return byLabel.key;
  }
  if (remembered.viewKey && views.some((v) => v.key === remembered.viewKey)) return remembered.viewKey;
  return fallbackKey;
}

function qualificationStyle(color) {
  const c = color ?? "var(--text-faint)";
  return { background: `color-mix(in srgb, ${c} 14%, transparent)`, "box-shadow": `inset 3px 0 0 ${c}` };
}

const recordLine = (row) => (row.draws !== null && row.draws > 0 ? `${row.wins}-${row.losses}-${row.draws}` : `${row.wins}-${row.losses}`);
const formatPct = (pct) => (pct === null ? "–" : pct.toFixed(3).replace(/^0/, ""));

function standingsTable({ group, section, label, followed, renumber }) {
  const record = group.standingsShape === "record";
  const rows = [...section.rows].sort(
    record
      ? (a, b) => (b.points ?? -1) - (a.points ?? -1) || (b.winPercent ?? -1) - (a.winPercent ?? -1) || b.wins - a.wins
      : (a, b) => (b.points ?? -1) - (a.points ?? -1) || a.rank - b.rank
  );
  return h(
    "table",
    { class: "sp-tbl" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        record ? null : h("th", { class: "pos" }, "#"),
        h("th", { class: "tm" }, label),
        record ? [h("th", {}, "W-L"), h("th", {}, section.rows.some((r) => r.points !== null) ? "Pts" : "Pct")] : h("th", {}, "Pts")
      )
    ),
    h(
      "tbody",
      {},
      rows.map((row, index) =>
        h(
          "tr",
          { class: isFollowed(followed, group.competitionKey, row.sourceTeamId) ? "is-you" : null, title: row.qualificationNote ?? null, style: row.qualifies ? qualificationStyle(row.qualificationColor) : undefined },
          record ? null : h("td", { class: "pos" }, row.qualifies && row.qualificationNote ? h("span", { class: "sp-tbl__advtext" }, row.qualificationNote) : null, String(renumber ? index + 1 : row.rank)),
          h("td", { class: "tm" }, h("span", { class: "nm" }, row.name)),
          record ? [h("td", {}, recordLine(row)), h("td", {}, String(row.points ?? formatPct(row.winPercent)))] : h("td", {}, String(row.points ?? "–"))
        )
      )
    )
  );
}

function knockTeam(side, edge, decided) {
  const state = decided ? (side.winner ? " is-winner" : " is-loser") : "";
  const caret = decided && side.winner;
  return h(
    "span",
    { class: `sp-knock__team sp-knock__team--${edge}${state}`, "aria-label": caret ? `${side.shortName}, winner` : null },
    edge === "home" && caret ? h("span", { class: "sp-knock__won", "aria-hidden": "true" }, "◂ ") : null,
    side.shortName,
    edge === "away" && caret ? h("span", { class: "sp-knock__won", "aria-hidden": "true" }, " ▸") : null
  );
}

function knockoutFixtures(fixtures, locale) {
  return h(
    "div",
    {},
    h("p", { class: "sp-knock__kicker" }, "Knockout stage"),
    h(
      "ul",
      { class: "sp-knock__list", "aria-label": "Current round fixtures" },
      fixtures.map((game) => {
        const decided = game.state === "final" && game.home.winner !== game.away.winner;
        const pre = game.state === "pre";
        return h(
          "li",
          { class: "sp-knock__row" },
          knockTeam(game.away, "away", decided),
          h("span", { class: "sp-knock__score" }, pre ? "v" : `${game.away.score ?? 0}–${game.home.score ?? 0}`),
          knockTeam(game.home, "home", decided),
          h("span", { class: "sp-knock__status" }, pre ? `${formatDate(game.startsAt, locale, { weekday: "short" })} ${formatTime(game.startsAt, locale)}` : game.statusDetail)
        );
      })
    )
  );
}

function viewSelect(views, value, onChange) {
  const nodes = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    nodes.push(h("optgroup", { label: run.conference }, run.views.map((v) => h("option", { value: v.key, selected: v.key === value }, v.label))));
    run = null;
  };
  for (const view of views) {
    if (view.conference) {
      if (run && run.conference !== view.conference) flush();
      run ??= { conference: view.conference, views: [] };
      run.views.push(view);
    } else {
      flush();
      nodes.push(h("option", { value: view.key, selected: view.key === value }, view.label));
    }
  }
  flush();
  const select = h("select", { class: "jds-select", "aria-label": "Select standings view", onChange: () => onChange(select.value) }, nodes);
  return select;
}

/**
 * The standings rail. `groups` holds standings the overview already carries (followed leagues).
 * Any other league is fetched on demand, and every tournament is fetched so it can show the knockout round.
 */
export function standingsRail({ groups, followed, activeKeys, api, ctx }) {
  const state = {
    catalog: [],
    follows: [],
    selected: null,
    lastViewed: null,
    selectedKey: "",
    viewOverride: null,
    competitionPicked: false,
    viewPicked: false,
    lazy: new Map(),
    loading: false,
    picker: null
  };
  const byKey = new Map(groups.map((g) => [g.competitionKey, g]));
  const root = h("section", { class: "sp-standings", "aria-label": "Standings" });
  const nav = h("span", { class: "sp-standings__nav" });
  const body = h("div", { class: "sp-standings__body" });
  const fade = h("div", { class: "sp-standings__fade", "aria-hidden": "true" });
  root.append(
    h("div", { class: "sp-standings__hd" }, h("h2", { class: "jds-eyebrow jds-eyebrow--strong jds-eyebrow--muted sp-standings__title" }, trophyIcon(), "Standings"), nav),
    body
  );

  let visibleKeys = [];
  const kindOf = (key) => state.catalog.find((c) => c.competitionKey === key)?.kind;

  function recompute() {
    const pg = buildStandingsPickerGroups(state.catalog, state.follows, state.selected, activeKeys);
    visibleKeys = pg.flatMap((g) => g.regions.flatMap((r) => r.competitions.map((c) => c.competitionKey)));
  }

  function activeKey() {
    return visibleKeys.includes(state.selectedKey) ? state.selectedKey : (visibleKeys[0] ?? "");
  }

  async function ensureLazy(key) {
    const isTournament = kindOf(key) === "tournament";
    if (!key || !(isTournament || !byKey.has(key)) || state.lazy.has(key)) return;
    state.loading = true;
    paint();
    try {
      const reply = await api.standings(key);
      state.lazy.set(key, { group: reply.group ?? null, fixtures: reply.fixtures ?? [], degraded: reply.degraded === true });
    } catch {
      state.lazy.set(key, { group: null, fixtures: [], degraded: true });
    }
    state.loading = false;
    paint();
  }

  function selectLeague(key) {
    state.competitionPicked = true;
    state.viewPicked = false;
    state.selectedKey = key;
    state.viewOverride = null;
    api.saveLastViewed({ competitionKey: key, viewKey: null, viewLabel: null }).catch(() => {});
    paint();
    ensureLazy(key);
  }

  function selectView(key, views, ak) {
    state.viewPicked = true;
    state.viewOverride = key;
    const view = views.find((v) => v.key === key);
    api.saveLastViewed({ competitionKey: ak, viewKey: key, viewLabel: view?.label ?? null }).catch(() => {});
    paint();
  }

  function paint() {
    const ak = activeKey();
    const isTournament = kindOf(ak) === "tournament";
    const lazyEnabled = ak !== "" && (isTournament || !byKey.has(ak));
    const lazy = lazyEnabled ? state.lazy.get(ak) : undefined;
    const group = lazy?.group ?? byKey.get(ak) ?? null;
    const fixtures = lazy?.fixtures ?? [];
    const degraded = lazy?.degraded === true;
    const knockout = isTournament && fixtures.length > 0;
    const views = buildViews(group?.sections ?? []);
    const defaultKey = group ? defaultViewKey(views, group.competitionKey, followed) : "all";
    const rememberedView = state.lastViewed && state.lastViewed.competitionKey === ak ? state.lastViewed : null;
    const rememberedViewKey = state.viewPicked ? null : resolveStandingsViewKey(rememberedView, views, defaultKey);
    const activeView = views.find((v) => v.key === (state.viewOverride ?? rememberedViewKey ?? defaultKey)) ?? views[0] ?? null;
    const merge = group && !isTournament && (activeView?.sections.length ?? 0) > 1 && activeView
      ? [{ label: activeView.key === "all" ? group.competitionLabel : activeView.label, conference: null, rows: activeView.sections.flatMap((s) => s.rows) }]
      : null;
    const shown = knockout ? [] : (merge ?? activeView?.sections ?? []);

    state.picker?.dispose?.();
    clear(nav);
    if (ak) {
      state.picker = standingsPicker({ catalog: state.catalog, follows: state.follows, selectedCompetitionKeys: state.selected, activeCompetitionKeys: activeKeys, value: ak, onChange: selectLeague });
      nav.append(state.picker);
    }
    if (ak && !knockout && views.length > 1) nav.append(viewSelect(views, activeView?.key ?? "all", (key) => selectView(key, views, ak)));

    const legend = Array.from(
      new Map(shown.flatMap((s) => s.rows).filter((r) => r.qualificationNote).map((r) => [r.qualificationNote, r])).values()
    );
    clear(body);
    if (degraded) body.append(h("p", { class: "sp-lede", role: "status" }, "Standings could not be updated just now, so they may be missing or out of date."));
    if (!ak) {
      body.append(h("p", {}, "No standings leagues selected. ", h("a", { class: "jds-btn jds-btn--link", href: SETTINGS_PATH, onClick: (e) => { e.preventDefault(); ctx.navigate(SETTINGS_PATH); } }, "Choose leagues in Settings.")));
    } else if (knockout) {
      body.append(knockoutFixtures(fixtures, ctx.locale));
    } else if (group && shown.length > 0) {
      for (const section of shown) body.append(standingsTable({ group, section, label: section.label ?? group.competitionLabel, followed, renumber: merge !== null }));
    } else {
      body.append(h("p", {}, state.loading ? "Loading standings…" : "No standings available."));
    }
    if (legend.length > 0) {
      body.append(
        h("ul", { class: "sp-legend", "aria-label": "Qualification key" }, legend.map((row) => h("li", { class: "sp-legend__item" }, h("span", { class: "sp-legend__marker", "aria-hidden": "true", style: qualificationStyle(row.qualificationColor) }), row.qualificationNote)))
      );
    }
    body.append(fade);
    measure();
  }

  function measure() {
    root.classList.toggle("sp-standings--more", body.scrollHeight - body.scrollTop - body.clientHeight > 8);
  }
  body.addEventListener("scroll", measure, { passive: true });

  (async () => {
    const [catalog, follows, prefs] = await Promise.all([
      api.catalog().catch(() => ({ competitions: [] })),
      api.follows().catch(() => ({ follows: [] })),
      api.standingsPreferences().catch(() => ({ selectedCompetitionKeys: null, lastViewed: null }))
    ]);
    state.catalog = catalog.competitions ?? [];
    state.follows = follows.follows ?? [];
    state.selected = prefs.selectedCompetitionKeys ?? null;
    state.lastViewed = prefs.lastViewed ?? null;
    recompute();
    state.selectedKey = resolveDefaultStandingsKey(state.lastViewed?.competitionKey ?? null, groups, visibleKeys, activeKeys, state.catalog);
    paint();
    ensureLazy(activeKey());
  })();

  return root;
}

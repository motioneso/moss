import { h, button, clear } from "./dom.mjs";
import { chevron, note, sectionHead, disclosure } from "./settings-ui.mjs";
import {
  followControlState,
  followFor,
  groupByConfederation,
  indexFollows,
  initials,
  leagueMatches,
  searchLeagueRows,
  wholeLeagueFollow
} from "./settings-logic.mjs";

const SEARCH_DELAY_MS = 250;

function crest(name, shortName, crestUrl) {
  const fallback = () => h("span", { class: "sp-pickcrest" }, initials(name, shortName));
  if (!crestUrl) return fallback();
  const img = h("img", { src: crestUrl, alt: "", width: 22, height: 22 });
  const wrap = h("span", { class: "sp-pickcrest" }, img);
  img.addEventListener("error", () => wrap.replaceChildren(initials(name, shortName)));
  return wrap;
}

function retryNote(text, onRetry) {
  return note(text, " ", button("Retry", { variant: "secondary", size: "sm", onClick: onRetry }));
}

/**
 * The Following block of the settings screen: followed chips, team and league search, and the
 * browse list grouped by confederation. `store` holds the shared catalog, follows and rosters.
 */
export function mountFollows({ api, store }) {
  let action = null;
  let query = "";
  let debounced = "";
  let timer = null;
  let search = { state: "idle", teams: [], partial: false };
  let expandedKey = null;
  let expanded = { state: "idle", teams: [] };
  let browseOpen = false;
  let searchRun = 0;
  let expandRun = 0;

  const root = h("div", {});
  const summary = h("div", {});
  const results = h("div", {});
  const input = h("input", {
    type: "search",
    class: "jds-input",
    "aria-label": "Find a team or league",
    placeholder: "Find a team or league…"
  });

  const pending = (competitionKey, teamKey, source) =>
    action?.phase === "pending" &&
    action.competitionKey === competitionKey &&
    action.teamKey === teamKey &&
    action.source === source
      ? action.direction
      : null;

  function actionError(competitionKey, teamKey, source) {
    if (
      action?.phase !== "error" ||
      action.competitionKey !== competitionKey ||
      action.teamKey !== teamKey ||
      action.source !== source
    ) {
      return null;
    }
    return h(
      "span",
      { class: "sp-action-error", role: "alert" },
      `Couldn’t ${action.direction === "follow" ? "follow" : "unfollow"} ${action.label}. Try again.`
    );
  }

  async function toggle(competitionKey, teamKey, label, source, sourceTeamId = null) {
    const existing = followFor(indexFollows(store.follows), competitionKey, teamKey, sourceTeamId);
    const direction = existing ? "unfollow" : "follow";
    action = { competitionKey, teamKey, label, direction, phase: "pending", source };
    paint();
    try {
      if (existing) await api.unfollow(existing.id);
      else await api.follow({ competitionKey, teamKey });
      action = null;
      await store.reloadFollows();
    } catch {
      action = { competitionKey, teamKey, label, direction, phase: "error", source };
    }
    paint();
  }

  function teamTile(team) {
    const active =
      followFor(
        indexFollows(store.follows),
        team.competitionKey,
        team.teamKey,
        team.sourceTeamId
      ) !== undefined;
    const busy = pending(team.competitionKey, team.teamKey, "picker");
    const state = followControlState("team", team.name, active, busy);
    const control = button(
      [
        h(
          "span",
          { class: "sp-team__top" },
          crest(team.name, team.shortName, team.crestUrl),
          h("span", { class: "sp-team__name" }, team.shortName || team.name)
        ),
        state.visible ? h("span", { class: "sp-team__state" }, state.visible) : null
      ],
      {
        variant: "chip",
        class: `jds-btn--block${active ? " jds-btn--active" : ""}`,
        "aria-pressed": String(active),
        "aria-label": state.ariaLabel,
        disabled: busy !== null,
        onClick: () =>
          toggle(team.competitionKey, team.teamKey, team.name, "picker", team.sourceTeamId)
      }
    );
    return h(
      "span",
      { class: "sp-action-target" },
      control,
      actionError(team.competitionKey, team.teamKey, "picker")
    );
  }

  function leagueButton(competition, wide, full) {
    const active = wholeLeagueFollow(indexFollows(store.follows), competition.competitionKey);
    const busy = pending(competition.competitionKey, null, "picker");
    const state = followControlState("league", competition.label, active !== undefined, busy);
    const visible = full
      ? state.visible
      : busy !== null
        ? state.visible
        : active
          ? "Following all"
          : "Follow all";
    return h(
      "span",
      { class: `sp-action-target${wide ? " sp-action-target--wide" : ""}` },
      button(h("span", {}, visible), {
        variant: "chip",
        class: active ? "jds-btn--active" : "",
        "aria-pressed": String(active !== undefined),
        "aria-label": state.ariaLabel,
        disabled: busy !== null,
        onClick: () => toggle(competition.competitionKey, null, competition.label, "picker")
      }),
      actionError(competition.competitionKey, null, "picker")
    );
  }

  function paintSummary() {
    clear(summary);
    if (store.follows.length === 0) return;
    const chips = h("div", {
      class: "sp-summary",
      role: "list",
      "aria-label": "Followed teams and leagues"
    });
    for (const follow of store.follows) {
      const competition = store.competitionsByKey.get(follow.competitionKey);
      const orphan = competition === undefined;
      const whole = follow.teamKey === null;
      const team = whole
        ? null
        : store.teamsByCompetition
            .get(follow.competitionKey)
            ?.find((t) =>
              follow.sourceTeamId !== null && follow.sourceTeamId !== undefined
                ? t.sourceTeamId === follow.sourceTeamId
                : t.teamKey === follow.teamKey
            );
      const label = orphan
        ? `Unrecognized league (${follow.competitionKey})`
        : whole
          ? `All ${competition.label}`
          : ((team?.shortName || team?.name || follow.teamKey) ?? "");
      const name = orphan
        ? label
        : whole
          ? competition.label
          : (team?.name ?? follow.teamKey ?? "");
      const busy = pending(follow.competitionKey, follow.teamKey, "summary") !== null;
      chips.append(
        h(
          "span",
          { class: "sp-chip", role: "listitem" },
          crest(name, whole ? null : team?.shortName, whole ? null : team?.crestUrl),
          h("span", { class: "sp-chip__lbl" }, label),
          h(
            "button",
            {
              type: "button",
              class: "jds-iconbtn jds-iconbtn--sm",
              "aria-label": `Unfollow ${label}`,
              disabled: busy,
              onClick: () =>
                toggle(follow.competitionKey, follow.teamKey, label, "summary", follow.sourceTeamId)
            },
            "×"
          ),
          actionError(follow.competitionKey, follow.teamKey, "summary")
        )
      );
    }
    summary.append(chips);
  }

  function renderSearch() {
    const out = [];
    if (search.state === "error") {
      out.push(retryNote("Couldn’t search right now.", runSearch));
      return out;
    }
    if (search.state === "loading") return [note("Searching…")];
    const leagues = searchLeagueRows(debounced, search.teams, store.competitions);
    if (search.teams.length === 0 && leagues.length === 0) {
      out.push(
        search.partial
          ? note("No matches yet — still covering more leagues. Try again in a moment.")
          : note("No teams or leagues match your search.")
      );
      return out;
    }
    const byLeague = new Map();
    for (const team of search.teams) {
      const list = byLeague.get(team.competitionKey) ?? [];
      list.push(team);
      byLeague.set(team.competitionKey, list);
    }
    const grouped = new Set(leagues.map((c) => c.competitionKey));
    const unknown = [
      ...new Set(
        search.teams.filter((t) => !grouped.has(t.competitionKey)).map((t) => t.competitionKey)
      )
    ];
    const matched = new Set(
      leagueMatches(debounced, store.competitions).map((c) => c.competitionKey)
    );
    for (const competition of leagues) {
      const teams = byLeague.get(competition.competitionKey) ?? [];
      out.push(
        h(
          "div",
          { class: "sp-search__group" },
          matched.has(competition.competitionKey)
            ? leagueButton(competition, true, true)
            : h("div", { class: "jds-eyebrow sp-search__group-heading" }, competition.label),
          teams.length > 0 ? h("div", { class: "sp-teamgrid" }, teams.map(teamTile)) : null
        )
      );
    }
    for (const key of unknown) {
      out.push(
        h(
          "div",
          { class: "sp-search__group" },
          h(
            "div",
            { class: "jds-eyebrow sp-search__group-heading" },
            `Unrecognized league (${key})`
          ),
          h("div", { class: "sp-teamgrid" }, (byLeague.get(key) ?? []).map(teamTile))
        )
      );
    }
    if (search.partial) out.push(note("Still covering more leagues…"));
    return out;
  }

  function renderBrowse() {
    const toggleBtn = disclosure(
      {
        className: "sp-browse-toggle",
        expanded: browseOpen,
        controls: "sp-browse-panel",
        onClick: () => {
          browseOpen = !browseOpen;
          paintResults();
        }
      },
      chevron(browseOpen),
      "Browse leagues"
    );
    if (!browseOpen) return [toggleBtn];
    const panel = h("div", { id: "sp-browse-panel" });
    for (const group of groupByConfederation(store.competitions)) {
      const block = h("div", {}, h("div", { class: "sp-browse__conf" }, group.label));
      for (const competition of group.competitions) {
        const open = expandedKey === competition.competitionKey;
        const row = h(
          "div",
          { class: "sp-browse__row" },
          disclosure(
            {
              className: "sp-browse__league",
              expanded: open,
              onClick: () => expand(open ? null : competition.competitionKey)
            },
            chevron(open),
            h("span", {}, competition.label)
          ),
          leagueButton(competition, false, false)
        );
        const holder = h("div", {}, row);
        if (open) {
          if (expanded.state === "loading") holder.append(note("Loading clubs…"));
          else if (expanded.state === "degraded") {
            holder.append(
              retryNote("Couldn’t load this league’s clubs.", () => expand(expandedKey, true))
            );
          } else holder.append(h("div", { class: "sp-teamgrid" }, expanded.teams.map(teamTile)));
        }
        block.append(holder);
      }
      panel.append(block);
    }
    return [toggleBtn, panel];
  }

  function paintResults() {
    clear(results);
    const trimmed = query.trim();
    if (trimmed.length >= 2) results.append(...renderSearch());
    else if (trimmed.length === 1)
      results.append(note("Search above to find teams or leagues to follow."));
    else results.append(...renderBrowse());
  }

  function paint() {
    paintSummary();
    paintResults();
  }

  async function expand(key, force = false) {
    if (key === expandedKey && !force) return;
    expandedKey = key;
    expanded = { state: key === null ? "idle" : "loading", teams: [] };
    paintResults();
    if (key === null) return;
    const mine = ++expandRun;
    try {
      const reply = await api.leagueTeams(key);
      if (mine !== expandRun) return;
      expanded = reply.degraded
        ? { state: "degraded", teams: [] }
        : { state: "ok", teams: reply.teams };
    } catch {
      if (mine !== expandRun) return;
      expanded = { state: "degraded", teams: [] };
    }
    paintResults();
  }

  async function runSearch() {
    const mine = ++searchRun;
    search = { state: "loading", teams: [], partial: false };
    paintResults();
    try {
      const reply = await api.searchTeams(debounced);
      if (mine !== searchRun) return;
      search = { state: "ok", teams: reply.teams ?? [], partial: reply.partial === true };
    } catch {
      if (mine !== searchRun) return;
      search = { state: "error", teams: [], partial: false };
    }
    paintResults();
  }

  input.addEventListener("input", () => {
    query = input.value;
    clearTimeout(timer);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      searchRun++;
      debounced = trimmed;
      paintResults();
      return;
    }
    timer = setTimeout(() => {
      debounced = trimmed;
      runSearch();
    }, SEARCH_DELAY_MS);
  });

  root.append(
    h(
      "div",
      { class: "sp-follow__head" },
      sectionHead("Following"),
      note("Follow competitions or teams to see them on your Sports page and in briefings.")
    ),
    summary,
    h("div", { class: "sp-search" }, h("div", { class: "jds-field" }, input)),
    results
  );
  paint();
  return { el: root, repaint: paint };
}

/* global window, document */
import { aroundLeaguesBoard } from "./board.mjs";
import { button, clear, h } from "./dom.mjs";
import {
  demoteEarlyGameday,
  gamedayHero,
  hasLiveGame,
  leadWidePhotoFirst,
  pageHeader
} from "./gameday.mjs";
import { heroCarousel, latestColumn, newsBand } from "./news.mjs";
import { trophyIcon } from "./parts.mjs";
import { followedTeamIndex } from "./ranking.mjs";
import { standingsRail } from "./standings.mjs";
import { SETTINGS_PATH, sportsTicker } from "./ticker.mjs";

const LIVE_REFETCH_INTERVAL_MS = 60000;

/** Mounts the Sports page into `root` and keeps it fresh. Returns a function that stops it. */
export function mountSportsPage({ root, api, ctx }) {
  const state = {
    data: null,
    error: false,
    activeGameId: null,
    resolving: null,
    resolveError: null
  };
  let timer = null;
  let disposers = [];
  let lastKey = "";
  let gone = false;

  const cleanUp = () => {
    for (const fn of disposers) fn();
    disposers = [];
  };
  const track = (el) => {
    if (el?.stop) disposers.push(() => el.stop());
    if (el?.dispose) disposers.push(() => el.dispose());
    return el;
  };

  async function load() {
    try {
      const next = await api.overview();
      if (gone) return;
      const key = JSON.stringify(next);
      const changed = key !== lastKey || state.error;
      lastKey = key;
      state.data = next;
      state.error = false;
      if (changed) render();
    } catch {
      if (gone) return;
      state.error = true;
      render();
    }
    schedule();
  }

  function schedule() {
    window.clearTimeout(timer);
    timer = null;
    if (gone || document.hidden || !hasLiveGame(state.data)) return;
    timer = window.setTimeout(load, LIVE_REFETCH_INTERVAL_MS);
  }

  const onVisible = () => {
    if (!document.hidden) load();
  };
  document.addEventListener("visibilitychange", onVisible);

  const retry = () => button("Try again", { variant: "link", onClick: () => load() });

  function render() {
    cleanUp();
    clear(root);
    const wrap = h("div", { class: "sp-wrap" });
    root.append(wrap);
    const data = state.data;

    if (!data) {
      wrap.append(
        state.error
          ? h(
              "p",
              { class: "sp-lede", role: "status" },
              "Sports are unavailable right now. ",
              retry()
            )
          : h("p", { class: "sp-lede", role: "status" }, "Loading your teams…")
      );
      return;
    }

    const followed = followedTeamIndex(data.followedTeams ?? []);
    const hasFollows = data.followed.length > 0 || data.followedLeagues.length > 0;
    const hero = demoteEarlyGameday(data);
    const games = hero.mode === "gameday" ? hero.games : [];
    const activeEntry = games.find((e) => e.game.id === state.activeGameId) ?? games[0] ?? null;

    const header = h("div", { class: "sp-mast-slot" });
    const setHeader = (game) => clear(header).append(...[pageHeader(game)].filter(Boolean));
    setHeader(activeEntry?.game ?? null);
    wrap.append(header);

    if (state.error) {
      wrap.append(
        h(
          "p",
          { class: "sp-lede", role: "status" },
          "Could not refresh sports. Showing the last loaded scores and stories. ",
          retry()
        )
      );
    }
    const ambiguous = ambiguousNotice(data.ambiguousFollows ?? []);
    if (ambiguous) wrap.append(ambiguous);
    if (data.degraded) {
      wrap.append(
        h(
          "p",
          { class: "sp-lede", role: "status" },
          "Some sports information could not be updated just now, so parts of this page may be missing."
        )
      );
    }

    const grid = (withTopStories) =>
      h(
        "div",
        { class: "sp-grid" },
        h(
          "div",
          { class: "sp-grid__main" },
          withTopStories ? latestColumn(data.topStories) : null,
          aroundLeaguesBoard(data.scoreboard, followed, ctx)
        ),
        h(
          "aside",
          { class: "sp-grid__rail" },
          track(
            standingsRail({
              groups: data.standings,
              followed,
              activeKeys: data.activeCompetitionKeys,
              api,
              ctx
            })
          )
        )
      );
    const band = () => newsBand({ groups: data.leagueNews, followed });

    if (!hasFollows) {
      wrap.append(emptyState());
      const hasSlate =
        data.topStories.length > 0 || data.standings.length > 0 || data.leagueNews.length > 0;
      if (hasSlate) wrap.append(h("div", { class: "sp-emptyboard" }, grid(true), band()));
      return;
    }

    if (activeEntry) {
      wrap.append(
        track(
          gamedayHero({
            games,
            activeId: activeEntry.game.id,
            overview: data,
            ctx,
            onActive: (game) => {
              state.activeGameId = game.id;
              setHeader(game);
            }
          })
        )
      );
    } else {
      wrap.append(
        track(
          heroCarousel({ headlines: leadWidePhotoFirst(data.topStories), degraded: data.degraded })
        )
      );
    }
    wrap.append(sportsTicker(data.followed, ctx), grid(hero.mode === "gameday"), band());
  }

  function ambiguousNotice(follows) {
    if (follows.length === 0) return null;
    return h(
      "section",
      { class: "sp-empty", "aria-label": "Saved teams that need a choice" },
      h(
        "div",
        { class: "sp-empty__inner" },
        h("h2", { class: "sp-empty__title" }, "Which team did you mean?"),
        follows.map(ambiguousChoice)
      )
    );
  }

  function ambiguousChoice(follow) {
    const savedName = follow.savedTeamKey.toUpperCase();
    if (!follow.teamListLoaded || follow.candidates.length === 0) {
      return h(
        "p",
        { class: "sp-empty__lede" },
        `We saved a team called ${savedName}, but today's team list could not be loaded, so we cannot ask which team you meant. Scores and standings stay on hold for this team until the list is back.`
      );
    }
    const box = h("div", {});
    let saving = null;
    let failed = false;
    const paint = () => {
      clear(box).append(
        h(
          "p",
          { class: "sp-empty__lede" },
          `We saved a team called ${savedName} before teams were pinned to a permanent number. Pick the right one and it comes straight back; until then its scores and standings are on hold.`
        ),
        follow.candidates.map((candidate) =>
          button(
            saving === candidate.sourceTeamId ? `Saving ${candidate.name}...` : candidate.name,
            {
              variant: "secondary",
              disabled: saving !== null,
              onClick: async () => {
                saving = candidate.sourceTeamId;
                failed = false;
                paint();
                try {
                  await api.resolveFollowTeam(follow.followId, candidate.sourceTeamId);
                  await load();
                } catch {
                  failed = true;
                } finally {
                  saving = null;
                  if (box.isConnected) paint();
                }
              }
            }
          )
        ),
        failed
          ? h("p", { class: "sp-empty__lede" }, "That choice could not be saved. Please try again.")
          : null
      );
    };
    paint();
    return box;
  }

  function emptyState() {
    return h(
      "section",
      { class: "sp-empty", "aria-label": "No teams followed" },
      h(
        "div",
        { class: "sp-empty__inner" },
        h("span", { class: "sp-empty__mark" }, trophyIcon()),
        h("h2", { class: "sp-empty__title" }, "Follow your teams"),
        h(
          "p",
          { class: "sp-empty__lede" },
          "Pick the teams and competitions you care about — this page fills with their scores, results, and headlines."
        ),
        h(
          "a",
          {
            class: "jds-btn jds-btn--secondary",
            href: SETTINGS_PATH,
            onClick: (event) => {
              event.preventDefault();
              ctx.navigate(SETTINGS_PATH);
            }
          },
          "Choose teams to follow"
        )
      )
    );
  }

  render();
  load();
  return () => {
    gone = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    cleanUp();
  };
}

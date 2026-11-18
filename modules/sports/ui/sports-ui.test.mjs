import assert from "node:assert/strict";
import test from "node:test";
import { sportsApi } from "./api.mjs";
import { demoteEarlyGameday, hasLiveGame, leadWidePhotoFirst } from "./gameday.mjs";
import { buildStandingsPickerGroups } from "./picker.mjs";
import { autoAdvance } from "./rotation.mjs";
import { followedTeamIndex, isFollowed } from "./ranking.mjs";
import { orderFollowedCards } from "./ticker.mjs";
import {
  ELSEWHERE_SCORES_MAX,
  TONIGHT_ROWS_MAX,
  deriveGamePhase,
  hasGameStartedToday,
  selectScoreRows,
  selectTonightRows
} from "./today-desk.mjs";
import { buildDesk } from "./today.mjs";

const locale = { timezone: "America/New_York", region: "en-US" };
const now = new Date("2026-11-17T20:00:00Z");
const side = (id, name = id) => ({
  teamKey: id,
  sourceTeamId: id,
  name,
  shortName: name,
  score: 1,
  crestUrl: null
});
const game = (id, state, startsAt, extra = {}) => ({
  id,
  competitionKey: "nfl",
  state,
  startsAt,
  statusDetail: state === "final" ? "Final" : "7:00 PM",
  recap: null,
  home: side(`h${id}`),
  away: side(`a${id}`),
  ...extra
});
const data = (games, extra = {}) => ({
  hero: { mode: "none" },
  scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games }],
  followed: [],
  followedLeagues: [],
  followedTeams: [],
  followedLeagueCards: [],
  topStories: [],
  standings: [],
  leagueNews: [],
  ...extra
});

test("a followed team is matched on its permanent id only", () => {
  const index = followedTeamIndex([
    { competitionKey: "nfl", sourceTeamId: "12", teamKey: "nyg" },
    { competitionKey: "nfl", sourceTeamId: null, teamKey: "dal" }
  ]);
  assert.equal(isFollowed(index, "nfl", "12"), true);
  assert.equal(isFollowed(index, "nfl", "nyg"), false);
  assert.equal(isFollowed(index, "nfl", null), false);
});

test("game phase follows the viewer's local day and the postponed words", () => {
  assert.equal(deriveGamePhase(game("1", "pre", "2026-11-18T01:00:00Z"), now, locale), "tonight");
  assert.equal(deriveGamePhase(game("2", "pre", "2026-11-19T01:00:00Z"), now, locale), "upcoming");
  assert.equal(
    deriveGamePhase(
      game("3", "pre", "2026-11-18T01:00:00Z", { statusDetail: "Postponed" }),
      now,
      locale
    ),
    "postponed"
  );
  assert.equal(deriveGamePhase(game("4", "live", "2026-11-17T19:00:00Z"), now, locale), "live");
});

test("scores put followed games first and cap the rest", () => {
  const games = Array.from({ length: 7 }, (_, i) =>
    game(String(i), "final", `2026-11-17T1${i}:00:00Z`)
  );
  games.push(game("mine", "final", "2026-11-17T09:00:00Z", { home: side("42", "Mine") }));
  const followed = followedTeamIndex([
    { competitionKey: "nfl", sourceTeamId: "42", teamKey: "mine" }
  ]);
  const { followedRows, elsewhereRows } = selectScoreRows(data(games), followed, now, locale);
  assert.deepEqual(
    followedRows.map((r) => r.game.id),
    ["mine"]
  );
  assert.equal(elsewhereRows.length, ELSEWHERE_SCORES_MAX);
});

test("tonight caps at six and lists postponed games from today", () => {
  const games = Array.from({ length: 9 }, (_, i) =>
    game(String(i), "pre", `2026-11-17T2${i % 4}:30:00Z`)
  );
  games.push(game("pp", "pre", "2026-11-17T23:00:00Z", { statusDetail: "Postponed" }));
  const { tonightRows, postponedRows } = selectTonightRows(
    data(games),
    followedTeamIndex([]),
    now,
    locale
  );
  assert.equal(tonightRows.length, TONIGHT_ROWS_MAX);
  assert.deepEqual(
    postponedRows.map((r) => r.game.id),
    ["pp"]
  );
});

test("a game live or finished today means the quiet-night line steps aside", () => {
  assert.equal(
    hasGameStartedToday(data([game("1", "final", "2026-11-17T17:00:00Z")]), now, locale),
    true
  );
  assert.equal(
    hasGameStartedToday(data([game("1", "pre", "2026-11-17T23:00:00Z")]), now, locale),
    false
  );
});

test("the desk is empty only when there is nothing to show", () => {
  const ctx = { locale, navigate() {} };
  assert.equal(buildDesk(data([]), ctx, now), null);
});

test("a game more than 15 minutes from kickoff leaves the gameday hero", () => {
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const entry = (g) => ({ game: g, competitionLabel: "NFL" });
  const hero = demoteEarlyGameday({
    ...data([]),
    hero: {
      mode: "gameday",
      games: [entry(game("a", "pre", soon)), entry(game("b", "pre", later))]
    }
  });
  assert.equal(hero.mode, "gameday");
  assert.deepEqual(
    hero.games.map((e) => e.game.id),
    ["a"]
  );
  const none = demoteEarlyGameday({
    ...data([]),
    hero: { mode: "gameday", games: [entry(game("b", "pre", later))] }
  });
  assert.equal(none.mode, "story");
});

test("polling is wanted only while something is live", () => {
  assert.equal(hasLiveGame(data([game("1", "final", "2026-11-17T17:00:00Z")])), false);
  assert.equal(hasLiveGame(data([game("1", "live", "2026-11-17T17:00:00Z")])), true);
  assert.equal(hasLiveGame(undefined), false);
});

test("a wide photo story leads the carousel", () => {
  const list = [{ id: "a" }, { id: "b", imageWidth: 1200 }, { id: "c" }];
  assert.deepEqual(
    leadWidePhotoFirst(list).map((x) => x.id),
    ["b", "a", "c"]
  );
});

test("followed cards order live first, then in season", () => {
  const cards = [
    { id: "idle", status: "idle", stories: [], competitionKey: "nfl" },
    { id: "live", status: "live", stories: [], competitionKey: "nfl" }
  ];
  assert.equal(orderFollowedCards(cards, Date.now())[0].id, "live");
});

test("the picker lists followed leagues first and leaves out unchosen ones", () => {
  const catalog = [
    { competitionKey: "nfl", kind: "league", sportLabel: "Football", regionLabel: "US" },
    { competitionKey: "nba", kind: "league", sportLabel: "Basketball", regionLabel: "US" },
    { competitionKey: "mlb", kind: "league", sportLabel: "Baseball", regionLabel: "US" }
  ];
  const groups = buildStandingsPickerGroups(catalog, [{ competitionKey: "nba" }], ["nfl", "nba"]);
  assert.equal(groups[0].label, "Following");
  assert.deepEqual(
    groups.slice(1).map((g) => g.label),
    ["Football"]
  );
});

test("the api turns failures into errors with a status and wraps the saved view", async () => {
  const seen = [];
  const client = {
    async request(method, path, body) {
      seen.push([method, path, body]);
      if (path === "/overview") return { status: 503, body: {} };
      return { status: 200, body: { ok: true } };
    }
  };
  const api = sportsApi(client);
  await assert.rejects(api.overview(), (error) => error.status === 503);
  await api.standings("nfl");
  await api.resolveFollowTeam("f 1", "9");
  assert.deepEqual(seen[1], ["GET", "/standings?competitionKey=nfl", undefined]);
  assert.deepEqual(seen[2], ["POST", "/follows/f%201/team", { sourceTeamId: "9" }]);
});

test("a carousel's rotation can be built before it paints its controls", () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    setInterval: () => 1,
    clearInterval: () => {}
  };
  try {
    const root = { addEventListener() {}, contains: () => false };
    let notified = 0;
    const rotation = autoAdvance({
      root,
      count: () => 3,
      advance: () => {},
      intervalMs: 1000,
      onChange: () => {
        notified += 1;
        assert.ok(rotation, "onChange must not run while the rotation is still being built");
      }
    });
    assert.equal(notified, 0);
    rotation.refresh();
    assert.equal(notified, 1);
  } finally {
    delete globalThis.window;
  }
});

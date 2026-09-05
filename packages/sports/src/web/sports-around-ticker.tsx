import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { GameSide, GameSummary, LocaleSettingsDto, ScoreboardGroup } from "@moss/shared";

import { LEAGUE_LOGOS, SOCCER_COMPETITIONS } from "./competitions.js";
import { formatTime, useUserLocale } from "./locale.js";
import type { FollowedTeamIndex } from "../news-ranking.js";
import { isFollowed } from "./sports-news.js";
import { Crest, LiveDot } from "./sports-parts.js";

// Marks hide themselves on a broken/missing image so entries degrade to text-only.
function Mark(props: { src: string | null; size: number; className: string }) {
  const [broken, setBroken] = useState(false);
  if (!props.src || broken) return null;
  return (
    <img
      className={props.className}
      src={props.src}
      alt=""
      width={props.size}
      height={props.size}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

// Crest-only team mark — the full name lives in the game's hover title. Teams without a
// usable crest keep their short name so a score never reads as "? 2–1 ?".
function TeamMark(props: { side: GameSide }) {
  const [broken, setBroken] = useState(false);
  const { side } = props;
  if (!side.crestUrl || broken) {
    return <span className="sp-around__team">{side.shortName}</span>;
  }
  return (
    <img
      className="sp-around__crest"
      src={side.crestUrl}
      alt={side.shortName}
      width={18}
      height={18}
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

function AroundGame(props: { game: GameSummary; soccer: boolean; locale: LocaleSettingsDto }) {
  const { game, soccer, locale } = props;
  const first: GameSide = soccer ? game.home : game.away;
  const second: GameSide = soccer ? game.away : game.home;
  const pre = game.state === "pre";
  const mid = pre ? (soccer ? "v" : "at") : `${first.score ?? "–"}–${second.score ?? "–"}`;
  return (
    <span className="sp-around__game" title={`${first.name} ${mid} ${second.name}`}>
      <TeamMark side={first} />
      <span className="sp-around__mid">{mid}</span>
      <TeamMark side={second} />
      <span className="sp-around__status">
        {pre ? formatTime(game.startsAt, locale) : game.statusDetail}
      </span>
    </span>
  );
}

// Live games lead each league group, then finals, then scheduled — "what's on right now"
// reads before results.
const STATE_ORDER: Record<GameSummary["state"], number> = { live: 0, final: 1, pre: 2 };

function byLiveness(a: GameSummary, b: GameSummary): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state];
}

// The server's scoreboard spans two ESPN days (yesterday..today Eastern) so tonight's games
// survive the Eastern-midnight flip — at 9:30 PM Pacific "today" alone is already tomorrow's
// slate. That means this filter can no longer show a feed verbatim; it has to cut the far day.
const NEAR_GAME_WINDOW_MS = 12 * 60 * 60 * 1000;

function startMs(game: GameSummary): number {
  return new Date(game.startsAt).getTime();
}

// A league with anything live shows the current slate: every live game plus whatever else
// starts within NEAR_GAME_WINDOW_MS of now — this morning's finals and tonight's kickoffs,
// but not yesterday's results or tomorrow's schedule from the two-day feed. With nothing
// live the strip shows whichever is closer to now: the most recent results or the next
// kickoffs — not both (live feedback mra4swdr). Distance to a final is measured from its
// start; close enough for "which side of now is this league on".
function nearNow(games: readonly GameSummary[]): GameSummary[] {
  const sorted = [...games].sort(byLiveness);
  const now = Date.now();
  if (sorted.some((g) => g.state === "live")) {
    return sorted.filter(
      (g) => g.state === "live" || Math.abs(startMs(g) - now) <= NEAR_GAME_WINDOW_MS
    );
  }
  const finals = sorted.filter((g) => g.state === "final");
  const pres = sorted.filter((g) => g.state === "pre");
  if (finals.length === 0 || pres.length === 0) return sorted;
  const sincePrev = now - Math.max(...finals.map(startMs));
  const untilNext = Math.min(...pres.map(startMs)) - now;
  return sincePrev <= untilNext ? finals : pres;
}

// Second, denser scores strip under the followed-teams ticker: every league's games in one
// horizontally-scrollable row, grouped by competition (#839). Complements the hero above it —
// this is an at-a-glance "everything that's on" strip, not a browseable list.
export function AroundLeaguesTicker({ groups }: { readonly groups: readonly ScoreboardGroup[] }) {
  const locale = useUserLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  function updateEdges(): void {
    const el = scrollRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  // Measure edges on mount and whenever `groups` changes (content can grow/shrink), plus on
  // viewport resize — a wider viewport can turn an overflowing strip into a non-overflowing one.
  // Without this, a strip that never fires `scroll` (content fits, or exactly fits) would render a
  // dead right arrow at rest.
  useEffect(() => {
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [groups]);

  if (groups.length === 0) return null;

  function nudge(direction: -1 | 1): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.8), behavior: "smooth" });
  }

  return (
    <section className="sp-around" aria-label="Scores around the leagues">
      <button
        type="button"
        className="sp-around__nav sp-around__nav--left"
        aria-label="Scroll left"
        hidden={atStart}
        onClick={() => nudge(-1)}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <div
        className="sp-around__scroll"
        ref={scrollRef}
        onScroll={updateEdges}
        tabIndex={0}
        role="region"
        aria-label="All scores, scrollable"
      >
        {/* The "Around the leagues" nameplate that opened the scroll was cut — it spent a
            card's worth of width on words the league plates already imply (live feedback
            mrav84vx); the section keeps its aria-label for non-visual readers. */}
        {groups.map((group) => (
          <div className="sp-around__group" key={group.competitionKey}>
            <span className="sp-around__league">
              <Mark
                src={LEAGUE_LOGOS[group.competitionKey] ?? null}
                size={16}
                className="sp-around__logo"
              />
              {group.competitionLabel}
            </span>
            {nearNow(group.games).map((game) => (
              <AroundGame
                key={game.id}
                game={game}
                soccer={SOCCER_COMPETITIONS.has(group.competitionKey)}
                locale={locale}
              />
            ))}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="sp-around__nav sp-around__nav--right"
        aria-label="Scroll right"
        hidden={atEnd}
        onClick={() => nudge(1)}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </section>
  );
}

/* ------------------------------------------------- Around-the-leagues board */

// Final-score emphasis: the winner reads at full weight, the loser dims. Only a decided
// game earns this — live/pre games and ties render both sides equally.
function winnerKey(game: GameSummary): string | null {
  if (game.state !== "final") return null;
  const home = Number(game.home.score);
  const away = Number(game.away.score);
  if (!Number.isFinite(home) || !Number.isFinite(away) || home === away) return null;
  return home > away ? game.home.teamKey : game.away.teamKey;
}

function BoardSide(props: { side: GameSide; pre: boolean; dim: boolean; followed: boolean }) {
  const { side } = props;
  // Followed team = a green row highlight, not a crest badge (mrba397w → revised by mrbad2i8:
  // the gold star "didn't look great"; Ben wants the whole team row tinted in the accent green,
  // like the standings "your team" marker). --dim and --you compose (a followed loser still dims).
  const cls = ["sp-board__side"];
  if (props.dim) cls.push("sp-board__side--dim");
  if (props.followed) cls.push("sp-board__side--you");
  return (
    <div className={cls.join(" ")}>
      <Crest name={side.name} crestUrl={side.crestUrl} size="sm" />
      <span className="sp-board__team" title={side.name}>
        {side.shortName}
      </span>
      {/* Pre-game rows carry no score cell at all — an empty mono column next to a kickoff
          time reads as a missing 0, not a scheduled game. */}
      {props.pre ? null : <span className="sp-board__score">{side.score ?? "–"}</span>}
    </div>
  );
}

// One scorebox: status line on top (clock/period for live, "Final", kickoff time for pre),
// then two stacked team rows. Soccer reads home-first, US leagues visitor-first — same
// data-driven convention as the strip and the featured-game bar.
function BoardGame(props: {
  game: GameSummary;
  soccer: boolean;
  locale: LocaleSettingsDto;
  competitionKey: string;
  followedPairs: FollowedTeamIndex;
}) {
  const { game, soccer, locale, competitionKey, followedPairs } = props;
  const first: GameSide = soccer ? game.home : game.away;
  const second: GameSide = soccer ? game.away : game.home;
  const pre = game.state === "pre";
  const winner = winnerKey(game);
  return (
    <div className="sp-board__game">
      <p className="sp-board__gstatus">
        {game.state === "live" ? <LiveDot /> : null}
        {pre ? formatTime(game.startsAt, locale) : game.statusDetail}
      </p>
      <BoardSide
        side={first}
        pre={pre}
        dim={winner !== null && winner !== first.teamKey}
        followed={isFollowed(followedPairs, competitionKey, first.teamKey, first.sourceTeamId)}
      />
      <BoardSide
        side={second}
        pre={pre}
        dim={winner !== null && winner !== second.teamKey}
        followed={isFollowed(followedPairs, competitionKey, second.teamKey, second.sourceTeamId)}
      />
    </div>
  );
}

// Around-the-leagues board (live feedback mrb4w77y): the strip's slate "in a broader format"
// in the broadsheet main column — the slot the Top-stories list held before the hero became
// a carousel of those same stories. One column per league (nameplate + stacked scoreboxes),
// columns scroll horizontally behind header arrows, and the section stretches to the
// standings rail's height (grid stretch in CSS) so the two columns read as one row of the
// page. Same nearNow() slate as the strip, so hiding the strip loses no information.
export function AroundLeaguesBoard({
  groups,
  followedPairs
}: {
  readonly groups: readonly ScoreboardGroup[];
  readonly followedPairs: FollowedTeamIndex;
}) {
  const locale = useUserLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  function updateEdges(): void {
    const el = scrollRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  // Same edge-measurement contract as the strip above: re-measure when content or viewport
  // changes so the arrows only offer scrolling that actually exists.
  useEffect(() => {
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [groups]);

  if (groups.length === 0) return null;

  function nudge(direction: -1 | 1): void {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.8), behavior: "smooth" });
  }

  return (
    <section className="sp-board" aria-label="Scores around the leagues">
      {/* Arrows live in the header, not flanking the row: the board runs as tall as the
          standings rail, and mid-height arrows float meaninglessly on tall columns. */}
      <div className="sp-board__hd">
        <p className="sp-col__kicker">Around the leagues</p>
        <div className="sp-board__navs">
          <button
            type="button"
            className="sp-board__nav"
            aria-label="Scroll left"
            hidden={atStart}
            onClick={() => nudge(-1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="sp-board__nav"
            aria-label="Scroll right"
            hidden={atEnd}
            onClick={() => nudge(1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {/* Body wrapper is the height anchor: it flexes to fill the grid row (which the standings
          rail sizes, mrb8wvo1) and the scroll fills it absolutely, so the board's own content
          never dictates the row height — it wraps into more columns instead of growing taller. */}
      <div className="sp-board__body">
        <div
          // Right-edge fade only while more scrolls right (mrba0kdh) — at the end the last
          // card must render crisp, not half-faded behind a dead scroll affordance.
          className={atEnd ? "sp-board__scroll" : "sp-board__scroll sp-board__scroll--more"}
          ref={scrollRef}
          onScroll={updateEdges}
          tabIndex={0}
          role="region"
          aria-label="All scores, scrollable"
        >
          {/* Leagues flow into shared vertical-wrap columns (mrb8wvo1 — no more one fixed column
              per league); the ink nameplate is the league separator inside the flow. */}
          {groups.map((group) => {
            const games = nearNow(group.games);
            const [firstGame, ...restGames] = games;
            const soccer = SOCCER_COMPETITIONS.has(group.competitionKey);
            return (
              <Fragment key={group.competitionKey}>
                {/* Nameplate is welded to its first score as ONE atomic flex item so a league
                    separator can never orphan at the bottom of a wrap-column (mrb9x3rk) — a flex
                    item never splits, so the pair wraps to the next column together. Remaining
                    games flow on their own after it. */}
                <div className="sp-board__lead">
                  <span className="sp-board__league">
                    <Mark
                      src={LEAGUE_LOGOS[group.competitionKey] ?? null}
                      size={16}
                      className="sp-around__logo"
                    />
                    {group.competitionLabel}
                  </span>
                  {firstGame ? (
                    <BoardGame
                      game={firstGame}
                      soccer={soccer}
                      locale={locale}
                      competitionKey={group.competitionKey}
                      followedPairs={followedPairs}
                    />
                  ) : null}
                </div>
                {restGames.map((game) => (
                  <BoardGame
                    key={game.id}
                    game={game}
                    soccer={soccer}
                    locale={locale}
                    competitionKey={group.competitionKey}
                    followedPairs={followedPairs}
                  />
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}

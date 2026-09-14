import type { ReactNode } from "react";

import {
  deriveGamePhase,
  localDay,
  type GameSide,
  type GameSummary,
  type LocaleSettingsDto,
  type SportsOverviewResponse
} from "@moss/shared";

import { isFollowed, type FollowedTeamIndex } from "../news-ranking.js";
import { SOCCER_COMPETITIONS } from "./competitions.js";
import { formatTime } from "./locale.js";
import { orderGameSides } from "./sports-around-ticker.js";
import { Crest, LiveDot } from "./sports-parts.js";

// Compact scores block and Tonight band for the Today Sports desk (T11). The selectors below
// are pure over the overview response so unit tests can pin ordering, caps and the local-day
// rule without rendering; the row components render only response values verbatim.

/** Second-group cap: followed games are uncapped, the rest of the league slate is not. */
export const ELSEWHERE_SCORES_MAX = 4;

/** Tonight band cap, by start time after the followed-first split. */
export const TONIGHT_ROWS_MAX = 6;

/** Approved quiet-night line, shown only when the band is empty and the desk renders anyway. */
export const QUIET_NIGHT_LINE =
  "A quiet night. No games for your followed teams or other featured matchups tonight.";

export interface ScoreRowData {
  readonly game: GameSummary;
  /** Human label from the scoreboard group or hero entry — the raw key is never rendered. */
  readonly competitionLabel: string;
  readonly followed: boolean;
}

export interface TonightRowData {
  readonly game: GameSummary;
  readonly competitionLabel: string;
  readonly followed: boolean;
}

function isFollowedSide(
  followed: FollowedTeamIndex,
  competitionKey: string,
  game: GameSummary
): boolean {
  return (
    isFollowed(followed, competitionKey, game.home.sourceTeamId) ||
    isFollowed(followed, competitionKey, game.away.sourceTeamId)
  );
}

function startMs(game: GameSummary): number {
  return new Date(game.startsAt).getTime();
}

/** Live rows first, then the most recent start — "what's on" reads before results. */
function byScoreOrder(a: ScoreRowData, b: ScoreRowData): number {
  if (a.game.state !== b.game.state) return a.game.state === "live" ? -1 : 1;
  return startMs(b.game) - startMs(a.game);
}

function followedFirstByStart(a: TonightRowData, b: TonightRowData): number {
  if (a.followed !== b.followed) return a.followed ? -1 : 1;
  return startMs(a.game) - startMs(b.game);
}

interface LabeledGame {
  readonly game: GameSummary;
  readonly competitionLabel: string;
}

/** Every game in the two-day window, hero games deduplicated by id. Labels travel with rows. */
function collectGames(data: SportsOverviewResponse): LabeledGame[] {
  const seen = new Set<string>();
  const games: LabeledGame[] = [];
  for (const group of data.scoreboard) {
    for (const game of group.games) {
      if (seen.has(game.id)) continue;
      seen.add(game.id);
      games.push({ game, competitionLabel: group.competitionLabel });
    }
  }
  if (data.hero.mode === "gameday") {
    for (const entry of data.hero.games) {
      if (seen.has(entry.game.id)) continue;
      seen.add(entry.game.id);
      games.push({ game: entry.game, competitionLabel: entry.competitionLabel });
    }
  }
  return games;
}

/** Final/live rows split into followed-first and capped elsewhere groups. */
export function selectScoreRows(
  data: SportsOverviewResponse,
  followed: FollowedTeamIndex,
  now: Date,
  timeZone: string
): { followedRows: ScoreRowData[]; elsewhereRows: ScoreRowData[] } {
  const rows: ScoreRowData[] = [];
  for (const { game, competitionLabel } of collectGames(data)) {
    const phase = deriveGamePhase(game, now, timeZone);
    if (phase !== "final" && phase !== "live") continue;
    rows.push({
      game,
      competitionLabel,
      followed: isFollowedSide(followed, game.competitionKey, game)
    });
  }
  const followedRows = rows.filter((row) => row.followed).sort(byScoreOrder);
  const elsewhereRows = rows
    .filter((row) => !row.followed)
    .sort(byScoreOrder)
    .slice(0, ELSEWHERE_SCORES_MAX);
  return { followedRows, elsewhereRows };
}

/** Tonight rows plus postponed today-games, each followed-first by start. */
export function selectTonightRows(
  data: SportsOverviewResponse,
  followed: FollowedTeamIndex,
  now: Date,
  timeZone: string
): { tonightRows: TonightRowData[]; postponedRows: TonightRowData[] } {
  const tonightRows: TonightRowData[] = [];
  const postponedRows: TonightRowData[] = [];
  for (const { game, competitionLabel } of collectGames(data)) {
    const phase = deriveGamePhase(game, now, timeZone);
    const row = {
      game,
      competitionLabel,
      followed: isFollowedSide(followed, game.competitionKey, game)
    };
    if (phase === "tonight") {
      tonightRows.push(row);
    } else if (
      phase === "postponed" &&
      localDay(game.startsAt, timeZone) === localDay(now, timeZone)
    ) {
      postponedRows.push(row);
    }
  }
  tonightRows.sort(followedFirstByStart);
  postponedRows.sort(followedFirstByStart);
  return {
    tonightRows: tonightRows.slice(0, TONIGHT_ROWS_MAX),
    postponedRows
  };
}

// Sides reuse the Around-the-leagues board row classes: same crest/name/score shape and
// the same followed highlight, with visual rules in the sanctioned (non-migrated) sheets.
function ScoreSide(props: { side: GameSide; followed: boolean }): ReactNode {
  const cls = ["sp-board__side"];
  if (props.followed) cls.push("sp-board__side--you");
  return (
    <div className={cls.join(" ")}>
      <Crest name={props.side.name} crestUrl={props.side.crestUrl} size="sm" />
      <span className="sp-board__team" title={props.side.name}>
        {props.side.shortName}
      </span>
      <span className="sp-board__score">{props.side.score ?? "\u2013"}</span>
    </div>
  );
}

/** One compact score row: both sides stacked, scores right, label and status verbatim. */
export function ScoreRow(props: { row: ScoreRowData; followed: FollowedTeamIndex }): ReactNode {
  const { row } = props;
  const [first, second] = orderGameSides(
    row.game,
    SOCCER_COMPETITIONS.has(row.game.competitionKey)
  );
  const live = row.game.state === "live";
  const firstFollowed = isFollowed(props.followed, row.game.competitionKey, first.sourceTeamId);
  const secondFollowed = isFollowed(props.followed, row.game.competitionKey, second.sourceTeamId);
  return (
    <li className="sp-scores__row">
      <div className="sp-scores__sides">
        <ScoreSide side={first} followed={firstFollowed} />
        <ScoreSide side={second} followed={secondFollowed} />
      </div>
      <div className="sp-scores__status">
        {live ? <LiveDot /> : null}
        {row.competitionLabel} · {row.game.statusDetail}
      </div>
    </li>
  );
}

/** One Tonight row: kicker, matchup and the local start time — or "Postponed". */
export function TonightRow(props: { row: TonightRowData; locale: LocaleSettingsDto }): ReactNode {
  const { row } = props;
  const soccer = SOCCER_COMPETITIONS.has(row.game.competitionKey);
  const matchup = soccer
    ? `${row.game.home.shortName} v ${row.game.away.shortName}`
    : `${row.game.away.shortName} at ${row.game.home.shortName}`;
  const postponed =
    row.game.statusDetail != null && /postpon|ppd|cancel/i.test(row.game.statusDetail);
  return (
    <li className="sp-tonight__row">
      <span className="sp-tonight__kicker">
        {row.followed ? "Following" : "Worth watching"} · {row.competitionLabel}
      </span>
      <span className="sp-tonight__matchup">{matchup}</span>
      <span className="sp-tonight__time">
        {postponed ? "Postponed" : formatTime(row.game.startsAt, props.locale)}
      </span>
    </li>
  );
}

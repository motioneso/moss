import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  GameSide,
  GameSummary,
  StandingsGroup,
  StandingsRow,
  StandingsSection,
  SportsStandingsResponse
} from "@moss/shared";

import { SPORTS_CATALOG, catalogEntry } from "../source/catalog.js";
import {
  getSportsCatalog,
  getSportsStandingsPreferences,
  getStandingsByLeague,
  listSportsFollows
} from "./sports-client.js";
import { sportsQueryKeys } from "./query-keys.js";
import { buildStandingsPickerGroups, StandingsPicker } from "./sports-standings-picker.js";
import type { FollowedTeamIndex } from "../news-ranking.js";
import { isFollowed } from "./sports-news.js";
import { formatDate, formatTime, useUserLocale } from "./locale.js";
import { TrophyIcon } from "./sports-parts.js";

// A pickable standings view: either the whole league ("All"), a whole conference, or a single
// division/group. `conference` buckets the option under an <optgroup>; null renders it top-level.
interface StandingsView {
  readonly key: string;
  readonly label: string;
  readonly conference: string | null;
  readonly sections: readonly StandingsSection[];
}

// US leagues nest divisions under conferences (AFC/NFC → AFC East…); soccer group stages are flat.
// "All" first, then per conference a whole-conference option followed by its divisions; flat tables
// collapse to "All" + one option per group. Works when `conference` is absent (older payloads).
function buildViews(sections: readonly StandingsSection[]): StandingsView[] {
  if (sections.length === 0) return [];
  const all: StandingsView = { key: "all", label: "All", conference: null, sections };
  const hasConference = sections.some((section) => section.conference);
  if (!hasConference) {
    if (sections.length === 1) return [all];
    return [
      all,
      ...sections.map((section, index) => ({
        key: `sec:${index}`,
        label: section.label ?? `Group ${index + 1}`,
        conference: null,
        sections: [section]
      }))
    ];
  }
  const order: string[] = [];
  const byConference = new Map<string, { section: StandingsSection; index: number }[]>();
  sections.forEach((section, index) => {
    const conference = section.conference ?? "";
    if (!byConference.has(conference)) {
      byConference.set(conference, []);
      order.push(conference);
    }
    byConference.get(conference)?.push({ section, index });
  });
  const views: StandingsView[] = [all];
  for (const conference of order) {
    const members = byConference.get(conference) ?? [];
    if (conference) {
      views.push({
        key: `conf:${conference}`,
        label: conference,
        conference,
        sections: members.map((m) => m.section)
      });
    }
    for (const { section, index } of members) {
      views.push({
        key: `sec:${index}`,
        label: section.label ?? `Group ${index + 1}`,
        conference: conference || null,
        sections: [section]
      });
    }
  }
  return views;
}

// Default view: US leagues with conferences open on "your" division (the section holding the
// viewer's followed team), falling back to the first division alphabetically. Everything else —
// flat leagues like MLS included — opens on "All": conference-split-by-default read as arbitrary
// halves of one table (live feedback mra50mfr, superseding the earlier followed-conference
// default). Tournaments also stay on "All" — the group stage reads as one page of tables. (#845.)
function defaultViewKey(
  views: readonly StandingsView[],
  competitionKey: string,
  followedPairs: FollowedTeamIndex
): string {
  const hasConference = views.some((v) => v.key.startsWith("conf:"));
  if (hasConference) {
    const sections = views.filter((v) => v.key.startsWith("sec:"));
    const followed = sections.find((v) =>
      v.sections[0]?.rows.some((row) =>
        isFollowed(followedPairs, competitionKey, row.sourceTeamId)
      )
    );
    if (followed) return followed.key;
    const alphabetical = [...sections].sort((a, b) => a.label.localeCompare(b.label));
    return alphabetical[0]?.key ?? "all";
  }
  return "all";
}

// The live preview proxies /api to a prod server that still serves the pre-#839 standings shape
// (a bare StandingsGroup, no `fixtures`). Accept either so the screen never white-screens before
// the new server ships.
function unwrapStandings(data: SportsStandingsResponse | StandingsGroup | undefined): {
  group: StandingsGroup | null;
  fixtures: readonly GameSummary[];
} {
  if (!data) return { group: null, fixtures: [] };
  if ("group" in data) return { group: data.group, fixtures: data.fixtures ?? [] };
  return { group: data, fixtures: [] };
}

export function StandingsRail(props: {
  groups: readonly StandingsGroup[];
  followedPairs: FollowedTeamIndex;
}) {
  const catalogQuery = useQuery({ queryKey: sportsQueryKeys.catalog, queryFn: getSportsCatalog });
  const followsQuery = useQuery({ queryKey: sportsQueryKeys.follows, queryFn: listSportsFollows });
  const preferencesQuery = useQuery({
    queryKey: sportsQueryKeys.standingsPreferences,
    queryFn: getSportsStandingsPreferences
  });
  const catalog = catalogQuery.data?.competitions ?? SPORTS_CATALOG;
  const follows = followsQuery.data?.follows ?? [];
  const selectedCompetitionKeys = preferencesQuery.data?.selectedCompetitionKeys ?? null;
  const pickerGroups = useMemo(
    () => buildStandingsPickerGroups(catalog, follows, selectedCompetitionKeys),
    [catalog, follows, selectedCompetitionKeys]
  );
  const visibleKeys = useMemo(
    () =>
      pickerGroups.flatMap((pickerGroup) =>
        pickerGroup.regions.flatMap((region) =>
          region.competitions.map((competition) => competition.competitionKey)
        )
      ),
    [pickerGroups]
  );
  const byKey = useMemo(
    () => new Map(props.groups.map((g) => [g.competitionKey, g])),
    [props.groups]
  );
  const firstKey =
    props.groups.find((standings) => visibleKeys.includes(standings.competitionKey))
      ?.competitionKey ??
    visibleKeys[0] ??
    "";
  const [selectedKey, setSelectedKey] = useState(firstKey);
  const activeKey = visibleKeys.includes(selectedKey) ? selectedKey : (visibleKeys[0] ?? "");
  // null = follow the derived default (followed team's division); a string = the viewer's own pick.
  const [viewOverride, setViewOverride] = useState<string | null>(null);

  // Vertical scroll affordance (Ben 2026-07-07): the rail is height-capped (mrbah9gw decouple),
  // so a 20-team division shows only its top ~14 rows with NO hint the rest is below — it "looks
  // like there's only fourteen teams and it doesn't look wrong". Track whether rows sit past the
  // scroll bottom and fade the last visible row as an honest "more below" cue (mirrors the board's
  // right-edge --more mask). Only shows when the list actually overflows, so a short division is
  // left clean.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [moreBelow, setMoreBelow] = useState(false);

  useEffect(() => {
    if (selectedKey !== activeKey) setSelectedKey(activeKey);
  }, [activeKey, selectedKey]);

  const isTournament = catalogEntry(activeKey)?.kind === "tournament";
  // The overview payload only carries standings for followed leagues; selecting a league outside
  // that set lazily fetches it via the dedicated standings route (#842). Tournaments always fetch
  // lazily too, because only that route carries the current-round `fixtures` (#839 follow-up).
  const lazy = useQuery({
    queryKey: sportsQueryKeys.standings(activeKey),
    queryFn: () => getStandingsByLeague(activeKey),
    enabled: activeKey !== "" && (isTournament || !byKey.has(activeKey))
  });

  const { group: lazyGroup, fixtures } = unwrapStandings(lazy.data);
  const group = lazyGroup ?? byKey.get(activeKey) ?? null;
  const knockout = isTournament && fixtures.length > 0;

  const views = useMemo(() => buildViews(group?.sections ?? []), [group?.sections]);
  const defaultKey = group
    ? defaultViewKey(views, group.competitionKey, props.followedPairs)
    : "all";
  const activeView = views.find((v) => v.key === (viewOverride ?? defaultKey)) ?? views[0] ?? null;
  // Every non-tournament league: "All" or a whole conference reads as ONE ranking, divisions/
  // conferences mixed, best to worst — not a stack of section tables (live feedback mra33whr,
  // widened from record leagues to MLS-style points leagues by mra50mfr). Tournament group
  // stages keep their separate tables: a World Cup "All" as one ranking would be meaningless.
  const mergeSections =
    group && !isTournament && (activeView?.sections.length ?? 0) > 1 && activeView
      ? [
          {
            label: activeView.key === "all" ? group.competitionLabel : activeView.label,
            conference: null,
            rows: activeView.sections.flatMap((section) => section.rows)
          } satisfies StandingsSection
        ]
      : null;
  const shownSections = knockout ? [] : (mergeSections ?? activeView?.sections ?? []);

  function selectLeague(competitionKey: string) {
    setSelectedKey(competitionKey);
    setViewOverride(null);
  }

  // ESPN can send a note with no description (advancement flagged, nothing to label) — such
  // rows still get the qualifying-row marker in the table but are omitted from the legend, which
  // only explains notes that actually have text (#841). Deduped across every shown section.
  const legendNotes = Array.from(
    new Map(
      shownSections
        .flatMap((section) => section.rows)
        .filter((row) => row.qualificationNote)
        .map((row) => [row.qualificationNote as string, row])
    ).values()
  );

  // Re-measure after every content swap (league/view change resizes the list) and on scroll/
  // resize. No dep array so a fresh render re-runs it; 8px slack clears the cue exactly at the
  // end past sub-pixel rounding. clientHeight is the capped viewport, scrollHeight the full list.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  });

  return (
    <section
      className={`sp-standings${moreBelow ? " sp-standings--more" : ""}`}
      aria-label="Standings"
    >
      <div className="sp-standings__hd">
        <span className="sp-standings__title">
          <TrophyIcon />
          Standings
        </span>
        <span className="sp-standings__nav">
          {activeKey ? (
            <StandingsPicker
              catalog={catalog}
              follows={follows}
              selectedCompetitionKeys={selectedCompetitionKeys}
              value={activeKey}
              onChange={selectLeague}
            />
          ) : null}
          {activeKey && !knockout && views.length > 1 ? (
            <ViewSelect
              views={views}
              value={activeView?.key ?? "all"}
              onChange={(next) => setViewOverride(next)}
            />
          ) : null}
        </span>
      </div>
      <div className="sp-standings__body" ref={scrollRef}>
        {!activeKey ? (
          <p className="sp-standings__empty">
            No standings leagues selected.{" "}
            <a href="/settings?section=modules&module=sports">Choose leagues in Settings.</a>
          </p>
        ) : knockout ? (
          <KnockoutFixtures fixtures={fixtures} />
        ) : group && shownSections.length > 0 ? (
          <>
            {shownSections.map((section, index) => (
              <StandingsTable
                key={section.label ?? index}
                group={group}
                section={section}
                label={section.label ?? group.competitionLabel}
                followedPairs={props.followedPairs}
                renumber={mergeSections !== null}
              />
            ))}
          </>
        ) : (
          <p className="sp-standings__empty">
            {lazy.isLoading ? "Loading standings…" : "No standings available."}
          </p>
        )}
        {legendNotes.length > 0 ? (
          <ul className="sp-legend" aria-label="Qualification key">
            {legendNotes.map((row) => (
              <li className="sp-legend__item" key={row.qualificationNote}>
                <span
                  className="sp-legend__marker"
                  aria-hidden="true"
                  style={qualificationStyle(row.qualificationColor)}
                />
                {row.qualificationNote}
              </li>
            ))}
          </ul>
        ) : null}
        {/* Sticky-bottom fade cue: negative margin so it overlays the last rows without adding
            scroll length; opacity toggled by --more so it only appears while more rows are below. */}
        <div className="sp-standings__fade" aria-hidden="true" />
      </div>
    </section>
  );
}

// Second dropdown: divisions/groups grouped under their conference. Consecutive views sharing a
// non-null conference collapse into one <optgroup>; conference-less views render as bare options.
function ViewSelect(props: {
  views: readonly StandingsView[];
  value: string;
  onChange: (key: string) => void;
}) {
  const nodes: ReactNode[] = [];
  let run: { conference: string; views: StandingsView[] } | null = null;
  const flushRun = () => {
    if (!run) return;
    nodes.push(
      <optgroup key={`grp:${run.conference}`} label={run.conference}>
        {run.views.map((view) => (
          <option key={view.key} value={view.key}>
            {view.label}
          </option>
        ))}
      </optgroup>
    );
    run = null;
  };
  for (const view of props.views) {
    if (view.conference) {
      if (run && run.conference !== view.conference) flushRun();
      run ??= { conference: view.conference, views: [] };
      run.views.push(view);
    } else {
      flushRun();
      nodes.push(
        <option key={view.key} value={view.key}>
          {view.label}
        </option>
      );
    }
  }
  flushRun();
  return (
    <select
      className="sp-standings__select"
      aria-label="Select standings view"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      {nodes}
    </select>
  );
}

// Once a tournament's group stage is complete the route returns the current knockout round's
// matches instead of a table (#839 follow-up): away · score-or-kickoff · home, status at the end.
// Decided matches mark the winner with a caret pointing at them and dim the loser — the score
// alone can't say who advanced after penalties (live feedback mra2zo1o).
function KnockoutFixtures(props: { fixtures: readonly GameSummary[] }) {
  const locale = useUserLocale();
  return (
    <div className="sp-knock">
      <p className="sp-knock__kicker">Knockout stage</p>
      <ul className="sp-knock__list" aria-label="Current round fixtures">
        {props.fixtures.map((game) => {
          const decided = game.state === "final" && game.home.winner !== game.away.winner;
          const pre = game.state === "pre";
          return (
            <li className="sp-knock__row" key={game.id}>
              <KnockTeam side={game.away} edge="away" decided={decided} />
              <span className="sp-knock__score">
                {pre ? "v" : `${game.away.score ?? 0}–${game.home.score ?? 0}`}
              </span>
              <KnockTeam side={game.home} edge="home" decided={decided} />
              {/* ESPN's pre-game statusDetail is a full sentence ("Tue, July 7th at 12:00 PM
                  EDT") in a different timezone — kickoff in the user's own locale instead
                  (live feedback mra4u9ju). */}
              <span className="sp-knock__status">
                {pre
                  ? `${formatDate(game.startsAt, locale, { weekday: "short" })} ${formatTime(game.startsAt, locale)}`
                  : game.statusDetail}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function KnockTeam(props: { side: GameSide; edge: "away" | "home"; decided: boolean }) {
  const { side, edge, decided } = props;
  const state = decided ? (side.winner ? " is-winner" : " is-loser") : "";
  // Caret sits between winner and score, pointing at the club that advanced.
  const caret = decided && side.winner;
  return (
    <span
      className={`sp-knock__team sp-knock__team--${edge}${state}`}
      aria-label={caret ? `${side.shortName}, winner` : undefined}
    >
      {edge === "home" && caret ? (
        <span className="sp-knock__won" aria-hidden="true">
          ◂{" "}
        </span>
      ) : null}
      {side.shortName}
      {edge === "away" && caret ? (
        <span className="sp-knock__won" aria-hidden="true">
          {" "}
          ▸
        </span>
      ) : null}
    </span>
  );
}

// PL-site-style qualification treatment: the whole row carries a faint tint of ESPN's
// per-note color plus a solid edge bar, instead of a marker dot. Colorless notes fall back
// to a neutral tint. The legend swatches reuse this so they read as miniature rows.
function qualificationStyle(color: string | null): CSSProperties {
  const c = color ?? "var(--text-faint)";
  return {
    background: `color-mix(in srgb, ${c} 14%, transparent)`,
    boxShadow: `inset 3px 0 0 ${c}`
  };
}

function StandingsTable(props: {
  group: StandingsGroup;
  section: StandingsSection;
  label: string;
  followedPairs: FollowedTeamIndex;
  // Merged All/conference views mix sections, so ESPN's per-section ranks repeat (two "#1"s in
  // an MLS East+West merge) — renumber by the sorted order instead (mra50mfr).
  renumber?: boolean;
}) {
  const { group, section, label } = props;
  // ESPN sometimes returns soccer tables in stale or fetch order — re-sort so the table
  // always reads best-first, while still displaying ESPN's own rank number as-is.
  // Record-shape leagues that carry points (NHL: W-L + Pts) rank by points, not win% —
  // sorting an NHL table by win% put teams out of standings order (live feedback mrawe0w4);
  // for NFL/MLB/NBA points is null on every row, so the comparator falls through to win%.
  const rows = [...section.rows].sort(
    group.standingsShape === "record"
      ? (a, b) =>
          (b.points ?? -1) - (a.points ?? -1) ||
          (b.winPercent ?? -1) - (a.winPercent ?? -1) ||
          b.wins - a.wins
      : (a, b) => (b.points ?? -1) - (a.points ?? -1) || a.rank - b.rank
  );
  return (
    <table className="sp-tbl">
      <thead>
        <tr>
          {group.standingsShape !== "record" ? <th className="pos">#</th> : null}
          <th className="tm">{label}</th>
          {group.standingsShape === "record" ? (
            <>
              <th>W-L</th>
              <th>{section.rows.some((r) => r.points !== null) ? "Pts" : "Pct"}</th>
            </>
          ) : (
            <th>Pts</th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            // Two teams in one table can share a short name (review finding S1), so the short
            // name alone is not a unique row identity — pair it with the permanent number, and
            // fall back to the row position when an older cached table carries no number.
            key={`${row.teamKey}:${row.sourceTeamId ?? index}`}
            className={
              isFollowed(props.followedPairs, group.competitionKey, row.sourceTeamId)
                ? "is-you"
                : undefined
            }
            title={row.qualificationNote ?? undefined}
            style={row.qualifies ? qualificationStyle(row.qualificationColor) : undefined}
          >
            {group.standingsShape !== "record" ? (
              <td className="pos">
                {row.qualifies && row.qualificationNote ? (
                  <span className="sp-tbl__advtext">{row.qualificationNote}</span>
                ) : null}
                {props.renumber ? index + 1 : row.rank}
              </td>
            ) : null}
            <td className="tm">
              <span className="nm">{row.name}</span>
            </td>
            {group.standingsShape === "record" ? (
              <>
                <td>{recordLine(row)}</td>
                <td>{row.points ?? formatPct(row.winPercent)}</td>
              </>
            ) : (
              <td>{row.points ?? "–"}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function recordLine(row: StandingsRow): string {
  return row.draws !== null && row.draws > 0
    ? `${row.wins}-${row.losses}-${row.draws}`
    : `${row.wins}-${row.losses}`;
}

function formatPct(winPercent: number | null): string {
  return winPercent === null ? "–" : winPercent.toFixed(3).replace(/^0/, "");
}

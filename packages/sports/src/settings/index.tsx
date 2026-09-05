import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Note, PaneHead } from "@moss/settings-ui";
import type {
  CompetitionRef,
  Confederation,
  CreateSportsFollowRequest,
  SportsCatalogResponse,
  SportsFollowDto,
  SportsFollowsResponse,
  SportsLeagueTeamsResponse,
  SportsTeamSearchResponse,
  TeamRef
} from "@moss/shared";
import { requestJson } from "@moss/module-web-sdk";

import { sportsQueryKeys } from "../web/query-keys.js";
import { StandingsLeaguesSection } from "./standings-leagues.js";
import { StoryPreferencesSection } from "./story-preferences.js";
import { SportsSourcesSection } from "./sources.js";
import "./sports-2.css";
import "./sports-sources.css";

const CATALOG_KEY = sportsQueryKeys.catalog;
const FOLLOWS_KEY = sportsQueryKeys.follows;

export { StandingsLeaguesSection };

// #907: the catalog contract dropped `teams` in Task 6 — this pane never read
// `competition.teams` (the local `CompetitionWithTeams` type was already gone), so every helper
// below already took plain `CompetitionRef`. The flip was a no-op here.

function getCatalog() {
  return requestJson<SportsCatalogResponse>("/api/sports/catalog");
}
function getFollows() {
  return requestJson<SportsFollowsResponse>("/api/sports/follows");
}
export function createFollow(body: CreateSportsFollowRequest) {
  return requestJson<{ follow: SportsFollowDto }>("/api/sports/follows", { method: "POST", body });
}
export function deleteFollow(id: string) {
  return requestJson<{ ok: boolean }>(`/api/sports/follows/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
// Lazy per-league roster (Task 3): backs both browse-expand and followed-chip name resolution,
// deduped by the shared `leagueTeams` query key (#907).
function getLeagueTeams(competitionKey: string) {
  return requestJson<SportsLeagueTeamsResponse>(
    `/api/sports/leagues/${encodeURIComponent(competitionKey)}/teams`
  );
}
// Cross-league server search (Task 4) — replaces the old client-side `filterTeams` scan, which
// depended on the catalog eagerly embedding every league's roster (#907).
function searchTeams(q: string) {
  return requestJson<SportsTeamSearchResponse>(
    `/api/sports/teams/search?q=${encodeURIComponent(q)}`
  );
}

/** Debounce the search box so each keystroke doesn't become a server query (#907). */
function useDebouncedValue(value: string, delayMs = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function initials(name: string, shortName?: string | null): string {
  if (shortName && shortName.trim().length > 0) return shortName.slice(0, 3).toUpperCase();
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? name;
  const last = parts[parts.length - 1] ?? name;
  const letters = parts.length >= 2 ? (first[0] ?? "") + (last[0] ?? "") : name.slice(0, 2);
  return letters.toUpperCase();
}

function PickCrest(props: { name: string; shortName?: string | null; crestUrl?: string | null }) {
  if (props.crestUrl) {
    return (
      <span className="sp-pickcrest">
        <img src={props.crestUrl} alt="" width={22} height={22} />
      </span>
    );
  }
  return <span className="sp-pickcrest">{initials(props.name, props.shortName)}</span>;
}

// composite key: teamKey null (whole league) -> "" sentinel
function followKey(competitionKey: string, teamKey: string | null): string {
  return `${competitionKey}::${teamKey ?? ""}`;
}

// A follow is matched to a picker tile on the provider's permanent team id, never on teamKey: two
// teams sharing a short name get composite list keys such as "pac.413" while the saved follow keeps
// the bare short name "pac" for display, so a key comparison never matched (Ben, dev, 2026-09-04).
// The id index uses an "id:" prefix, which no catalog key can contain (keys are dot-only), so the
// two kinds of entry cannot collide. Whole-league follows (no id) index by key alone.
function followIdKey(competitionKey: string, sourceTeamId: string): string {
  return followKey(competitionKey, `id:${sourceTeamId}`);
}

export function indexFollows(follows: readonly SportsFollowDto[]): Map<string, SportsFollowDto> {
  const index = new Map<string, SportsFollowDto>();
  for (const follow of follows) {
    index.set(followKey(follow.competitionKey, follow.teamKey), follow);
    if (follow.sourceTeamId !== null) {
      index.set(followIdKey(follow.competitionKey, follow.sourceTeamId), follow);
    }
  }
  return index;
}

/**
 * The saved follow a tile stands for: by permanent id when the tile has one, else by key.
 *
 * A tile with a permanent id falls back to the key only for an older save that has no id of its
 * own. Two teams that share a short name can swap places in the list between refreshes (the
 * Tigers saved as "pac"/413, then a list holding only the Lutes as "pac"/129700), and a follow
 * with a different id must never be treated as this tile's, or the Lutes tile would show as
 * followed and its click would remove the Tigers follow (review round 7).
 */
export function followFor(
  index: ReadonlyMap<string, SportsFollowDto>,
  competitionKey: string,
  teamKey: string | null,
  sourceTeamId: string | null
): SportsFollowDto | undefined {
  const byId =
    sourceTeamId === null ? undefined : index.get(followIdKey(competitionKey, sourceTeamId));
  if (byId !== undefined) return byId;
  const byKey = index.get(followKey(competitionKey, teamKey));
  if (byKey === undefined) return undefined;
  if (sourceTeamId !== null && byKey.sourceTeamId !== null) return undefined;
  return byKey;
}

type FollowActionSource = "summary" | "picker";

type FollowActionState = {
  competitionKey: string;
  teamKey: string | null;
  label: string;
  direction: "follow" | "unfollow";
  phase: "pending" | "error";
  source: FollowActionSource;
} | null;

function pendingDirectionFor(
  actionState: FollowActionState,
  competitionKey: string,
  teamKey: string | null,
  source: FollowActionSource
): "follow" | "unfollow" | null {
  if (actionState?.phase !== "pending") return null;
  if (
    actionState.competitionKey !== competitionKey ||
    actionState.teamKey !== teamKey ||
    actionState.source !== source
  ) {
    return null;
  }
  return actionState.direction;
}

function ActionError(props: {
  actionState: FollowActionState;
  competitionKey: string;
  teamKey: string | null;
  source: FollowActionSource;
}) {
  const action = props.actionState;
  if (
    action?.phase !== "error" ||
    action.competitionKey !== props.competitionKey ||
    action.teamKey !== props.teamKey ||
    action.source !== props.source
  ) {
    return null;
  }
  return (
    <span className="sp-action-error" role="alert">
      {`Couldn’t ${action.direction === "follow" ? "follow" : "unfollow"} ${action.label}. Try again.`}
    </span>
  );
}

/** Truthful follow/unfollow control copy — one source of truth for team and whole-league
    buttons so the visible label and accessible name never diverge (#989 spec Decision 2). */
export function followControlState(
  variant: "team" | "league",
  subjectLabel: string,
  active: boolean,
  pending: "follow" | "unfollow" | null
): { visible: string; ariaLabel: string } {
  if (pending === "follow") return { visible: "Following…", ariaLabel: "Following…" };
  if (pending === "unfollow") return { visible: "Unfollowing…", ariaLabel: "Unfollowing…" };
  const followLabel =
    variant === "league" ? `Follow all of ${subjectLabel}` : `Follow ${subjectLabel}`;
  // Team chips carry no "Follow X" text (Ben, 2026-09-03): the chip itself is the control and
  // the accessible name still says it. The "Following" state text stays.
  if (!active) return { visible: variant === "team" ? "" : followLabel, ariaLabel: followLabel };
  if (variant === "team") return { visible: "Following", ariaLabel: `Unfollow ${subjectLabel}` };
  return {
    visible: `Following all of ${subjectLabel}`,
    ariaLabel: `Unfollow all of ${subjectLabel}`
  };
}

/* ----- Sports-local, pure search helpers (unit-tested). No generic picker
   abstraction — scoped to this catalog shape on purpose. ----- */

/** Competitions whose label matches a non-empty query. Empty query returns []. Loosened to plain
    `CompetitionRef` (#907) — no longer needs a roster, since the server owns team matching. */
export function leagueMatches(
  query: string,
  competitions: readonly CompetitionRef[]
): readonly CompetitionRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return competitions.filter((c) => c.label.toLowerCase().includes(q));
}

/** League rows for search results: catalog-label matches plus the parent league of every server
    result (so "arsenal" also offers "Follow all of Premier League"), deduped by key (#907). */
export function searchLeagueRows(
  query: string,
  resultTeams: readonly TeamRef[],
  competitions: readonly CompetitionRef[]
): readonly CompetitionRef[] {
  const byKey = new Map<string, CompetitionRef>();
  for (const competition of leagueMatches(query, competitions)) {
    byKey.set(competition.competitionKey, competition);
  }
  const compsByKey = new Map(competitions.map((c) => [c.competitionKey, c]));
  for (const team of resultTeams) {
    const competition = compsByKey.get(team.competitionKey);
    if (competition) byKey.set(competition.competitionKey, competition);
  }
  return [...byKey.values()];
}

function FollowedSummary(props: {
  follows: readonly SportsFollowDto[];
  competitionsByKey: Map<string, CompetitionRef>;
  // The catalog no longer carries rosters, so chip name/crest resolution needs each followed
  // team's league roster looked up separately (fetched by SportsSettings via getLeagueTeams,
  // #907 spec §4.3).
  teamsByCompetition: Map<string, readonly TeamRef[]>;
  onToggle: (
    competitionKey: string,
    teamKey: string | null,
    label: string,
    source: FollowActionSource,
    sourceTeamId?: string | null
  ) => void;
  actionState: FollowActionState;
}) {
  if (props.follows.length === 0) return null;
  return (
    <div className="sp-summary" role="list" aria-label="Followed teams and leagues">
      {props.follows.map((follow) => {
        const competition = props.competitionsByKey.get(follow.competitionKey);
        // A competitionKey with no catalog entry (e.g. a retired/renamed league) would
        // otherwise render as a raw, unhumanized key — call it out instead (#765 M3). Still
        // removable via the same button below.
        const orphan = competition === undefined;
        const wholeLeague = follow.teamKey === null;
        // Match the roster entry on the permanent id when the follow has one; the saved teamKey is
        // a display short name that may not equal a colliding team's composite list key.
        const team = wholeLeague
          ? null
          : props.teamsByCompetition
              .get(follow.competitionKey)
              ?.find((t) =>
                follow.sourceTeamId !== null
                  ? t.sourceTeamId === follow.sourceTeamId
                  : t.teamKey === follow.teamKey
              );
        const label = orphan
          ? `Unrecognized league (${follow.competitionKey})`
          : wholeLeague
            ? `All ${competition?.label ?? follow.competitionKey}`
            : ((team?.shortName || team?.name || follow.teamKey) ?? "");
        const name = orphan
          ? label
          : wholeLeague
            ? (competition?.label ?? follow.competitionKey)
            : (team?.name ?? follow.teamKey ?? "");
        return (
          <span key={follow.id} className="sp-chip" role="listitem">
            <PickCrest
              name={name}
              shortName={wholeLeague ? null : team?.shortName}
              crestUrl={wholeLeague ? null : team?.crestUrl}
            />
            <span className="sp-chip__lbl">{label}</span>
            <button
              type="button"
              className="sp-chip__remove"
              aria-label={`Unfollow ${label}`}
              disabled={
                pendingDirectionFor(
                  props.actionState,
                  follow.competitionKey,
                  follow.teamKey,
                  "summary"
                ) !== null
              }
              onClick={() =>
                props.onToggle(
                  follow.competitionKey,
                  follow.teamKey,
                  label,
                  "summary",
                  follow.sourceTeamId
                )
              }
            >
              ×
            </button>
            <ActionError
              actionState={props.actionState}
              competitionKey={follow.competitionKey}
              teamKey={follow.teamKey}
              source="summary"
            />
          </span>
        );
      })}
    </div>
  );
}

export function SearchResults(props: {
  query: string;
  results: readonly TeamRef[];
  partial: boolean;
  isError: boolean;
  onRetry: () => void;
  competitions: readonly CompetitionRef[];
  followsByKey: Map<string, SportsFollowDto>;
  onToggle: (
    competitionKey: string,
    teamKey: string | null,
    label: string,
    source: FollowActionSource,
    sourceTeamId?: string | null
  ) => void;
  actionState: FollowActionState;
}) {
  // A failed search request must never masquerade as an authoritative "no matches" — that would
  // tell the user their club isn't supported when we simply couldn't ask the server (#907 review
  // Important-1). Transport errors get an explicit retry, mirroring BrowseGroups' degraded path.
  if (props.isError) {
    return (
      <Note>
        Couldn&rsquo;t search right now.{" "}
        <button type="button" className="sp-managebtn" onClick={props.onRetry}>
          Retry
        </button>
      </Note>
    );
  }
  const leagues = searchLeagueRows(props.query, props.results, props.competitions);
  if (props.results.length === 0 && leagues.length === 0) {
    // `partial` = the server's warm-fill hasn't covered every league yet this process lifetime —
    // NOT an error, so this stays a soft note rather than the blanket error/degraded notices
    // below (#907 spec §4.4).
    return props.partial ? (
      <Note>No matches yet — still covering more leagues. Try again in a moment.</Note>
    ) : (
      <Note>No teams or leagues match your search.</Note>
    );
  }
  return (
    <>
      {leagues.map((competition) => {
        const wholeActive = props.followsByKey.has(followKey(competition.competitionKey, null));
        const pendingHere = pendingDirectionFor(
          props.actionState,
          competition.competitionKey,
          null,
          "picker"
        );
        const state = followControlState("league", competition.label, wholeActive, pendingHere);
        return (
          <span
            key={`l-${competition.competitionKey}`}
            className="sp-action-target sp-action-target--wide"
          >
            <button
              type="button"
              className={`sp-whole${wholeActive ? " is-active" : ""}`}
              aria-pressed={wholeActive}
              aria-label={state.ariaLabel}
              disabled={pendingHere !== null}
              onClick={() =>
                props.onToggle(competition.competitionKey, null, competition.label, "picker")
              }
            >
              <span className="sp-whole__lbl">{state.visible}</span>
            </button>
            <ActionError
              actionState={props.actionState}
              competitionKey={competition.competitionKey}
              teamKey={null}
              source="picker"
            />
          </span>
        );
      })}
      <div className="sp-teamgrid">
        {props.results.map((team) => {
          const active =
            followFor(props.followsByKey, team.competitionKey, team.teamKey, team.sourceTeamId) !==
            undefined;
          const pendingHere = pendingDirectionFor(
            props.actionState,
            team.competitionKey,
            team.teamKey,
            "picker"
          );
          const state = followControlState("team", team.name, active, pendingHere);
          return (
            <span className="sp-action-target" key={`${team.competitionKey}:${team.teamKey}`}>
              <button
                type="button"
                className={`sp-team${active ? " is-active" : ""}`}
                aria-pressed={active}
                aria-label={state.ariaLabel}
                disabled={pendingHere !== null}
                onClick={() =>
                  props.onToggle(
                    team.competitionKey,
                    team.teamKey,
                    team.name,
                    "picker",
                    team.sourceTeamId
                  )
                }
              >
                <span className="sp-team__top">
                  <PickCrest name={team.name} shortName={team.shortName} crestUrl={team.crestUrl} />
                  <span className="sp-team__name">{team.shortName || team.name}</span>
                </span>
                {state.visible ? <span className="sp-team__state">{state.visible}</span> : null}
              </button>
              <ActionError
                actionState={props.actionState}
                competitionKey={team.competitionKey}
                teamKey={team.teamKey}
                source="picker"
              />
            </span>
          );
        })}
      </div>
      {props.partial ? <Note>Still covering more leagues…</Note> : null}
    </>
  );
}

// Ordered so the (soccer-only) confederation grouping still leads with what most users follow —
// US majors/global tournaments first, then FIFA's six confederations alphabetically-by-region
// (#907 spec §4.2 browse ordering).
const CONFEDERATION_ORDER: readonly Confederation[] = [
  "INTL",
  "UEFA",
  "CONCACAF",
  "CONMEBOL",
  "AFC",
  "CAF",
  "OFC"
];
const CONFEDERATION_LABELS: Record<Confederation, string> = {
  INTL: "US majors & global",
  UEFA: "Europe · UEFA",
  CONCACAF: "North & Central America · CONCACAF",
  CONMEBOL: "South America · CONMEBOL",
  AFC: "Asia · AFC",
  CAF: "Africa · CAF",
  OFC: "Oceania · OFC"
};

/** Confederation-grouped browse mode, shown when the search box is empty. Purely prop-driven (the
    roster query lives in `SportsSettings`) so this stays SSR-string-testable like `SearchResults`
    (#907). Leagues are fetched lazily: only the expanded league's roster query is enabled. */
export function BrowseGroups(props: {
  competitions: readonly CompetitionRef[];
  followsByKey: Map<string, SportsFollowDto>;
  expandedKey: string | null;
  onExpand: (competitionKey: string | null) => void;
  expandedTeams: readonly TeamRef[];
  expandedLoading: boolean;
  expandedDegraded: boolean;
  onRetryExpanded: () => void;
  onToggle: (
    competitionKey: string,
    teamKey: string | null,
    label: string,
    source: FollowActionSource,
    sourceTeamId?: string | null
  ) => void;
  actionState: FollowActionState;
}) {
  const byConfederation = new Map<Confederation, CompetitionRef[]>();
  for (const competition of props.competitions) {
    const group = byConfederation.get(competition.confederation);
    if (group) group.push(competition);
    else byConfederation.set(competition.confederation, [competition]);
  }
  const populatedOrder = CONFEDERATION_ORDER.filter(
    (conf) => (byConfederation.get(conf)?.length ?? 0) > 0
  );
  return (
    <>
      {populatedOrder.map((conf) => (
        <div key={conf}>
          <div className="sp-browse__conf">{CONFEDERATION_LABELS[conf]}</div>
          {(byConfederation.get(conf) ?? []).map((competition) => {
            const expanded = props.expandedKey === competition.competitionKey;
            const wholeActive = props.followsByKey.has(followKey(competition.competitionKey, null));
            const wholePendingHere = pendingDirectionFor(
              props.actionState,
              competition.competitionKey,
              null,
              "picker"
            );
            const wholeState = followControlState(
              "league",
              competition.label,
              wholeActive,
              wholePendingHere
            );
            return (
              <div key={competition.competitionKey}>
                <div className="sp-browse__row">
                  <button
                    type="button"
                    className="sp-browse__league"
                    aria-expanded={expanded}
                    onClick={() => props.onExpand(expanded ? null : competition.competitionKey)}
                  >
                    {expanded ? (
                      <ChevronDown size={16} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={16} aria-hidden="true" />
                    )}
                    <span>{competition.label}</span>
                  </button>
                  <span className="sp-action-target">
                    <button
                      type="button"
                      className={`sp-whole${wholeActive ? " is-active" : ""}`}
                      aria-pressed={wholeActive}
                      aria-label={wholeState.ariaLabel}
                      disabled={wholePendingHere !== null}
                      onClick={() =>
                        props.onToggle(
                          competition.competitionKey,
                          null,
                          competition.label,
                          "picker"
                        )
                      }
                    >
                      <span className="sp-whole__lbl">
                        {/* The league name already heads the row, so the button reads
                            "Follow all" and every row's button lines up at one width
                            (Ben, 2026-09-03). The aria-label keeps the full name. */}
                        {wholePendingHere !== null
                          ? wholeState.visible
                          : wholeActive
                            ? "Following all"
                            : "Follow all"}
                      </span>
                    </button>
                    <ActionError
                      actionState={props.actionState}
                      competitionKey={competition.competitionKey}
                      teamKey={null}
                      source="picker"
                    />
                  </span>
                </div>
                {expanded ? (
                  props.expandedLoading ? (
                    <Note>Loading clubs…</Note>
                  ) : props.expandedDegraded ? (
                    <Note>
                      Couldn&rsquo;t load this league&rsquo;s clubs.{" "}
                      <button
                        type="button"
                        className="sp-managebtn"
                        onClick={props.onRetryExpanded}
                      >
                        Retry
                      </button>
                    </Note>
                  ) : (
                    <div className="sp-teamgrid">
                      {props.expandedTeams.map((team) => {
                        const active =
                          followFor(
                            props.followsByKey,
                            team.competitionKey,
                            team.teamKey,
                            team.sourceTeamId
                          ) !== undefined;
                        const pendingHere = pendingDirectionFor(
                          props.actionState,
                          team.competitionKey,
                          team.teamKey,
                          "picker"
                        );
                        const state = followControlState("team", team.name, active, pendingHere);
                        return (
                          <span
                            className="sp-action-target"
                            key={`${team.competitionKey}:${team.teamKey}`}
                          >
                            <button
                              type="button"
                              className={`sp-team${active ? " is-active" : ""}`}
                              aria-pressed={active}
                              aria-label={state.ariaLabel}
                              disabled={pendingHere !== null}
                              onClick={() =>
                                props.onToggle(
                                  team.competitionKey,
                                  team.teamKey,
                                  team.name,
                                  "picker",
                                  team.sourceTeamId
                                )
                              }
                            >
                              <span className="sp-team__top">
                                <PickCrest
                                  name={team.name}
                                  shortName={team.shortName}
                                  crestUrl={team.crestUrl}
                                />
                                <span className="sp-team__name">{team.shortName || team.name}</span>
                              </span>
                              {state.visible ? (
                                <span className="sp-team__state">{state.visible}</span>
                              ) : null}
                            </button>
                            <ActionError
                              actionState={props.actionState}
                              competitionKey={team.competitionKey}
                              teamKey={team.teamKey}
                              source="picker"
                            />
                          </span>
                        );
                      })}
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

export default function SportsSettings() {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({ queryKey: CATALOG_KEY, queryFn: getCatalog });
  const followsQuery = useQuery({ queryKey: FOLLOWS_KEY, queryFn: getFollows });

  const invalidateFollows = () => {
    void queryClient.invalidateQueries({ queryKey: FOLLOWS_KEY });
    void queryClient.invalidateQueries({ queryKey: sportsQueryKeys.overview });
  };
  const followMutation = useMutation({ mutationFn: createFollow, onSuccess: invalidateFollows });
  const unfollowMutation = useMutation({ mutationFn: deleteFollow, onSuccess: invalidateFollows });

  const competitions = catalogQuery.data?.competitions ?? [];
  const follows = followsQuery.data?.follows ?? [];
  const followsByKey = indexFollows(follows);
  const competitionsByKey = new Map<string, CompetitionRef>(
    competitions.map((c) => [c.competitionKey, c])
  );

  const [search, setSearch] = useState("");
  const query = search.trim();
  // Debounce the box so typing doesn't fire a server request per keystroke; the immediate `query`
  // still drives the 1-char hint below so the UI reacts instantly to typing (#907).
  const debouncedQuery = useDebouncedValue(query);
  const searchEnabled = debouncedQuery.length >= 2;
  const searchQuery = useQuery({
    queryKey: sportsQueryKeys.teamSearch(debouncedQuery),
    queryFn: () => searchTeams(debouncedQuery),
    enabled: searchEnabled
  });

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expandedQuery = useQuery({
    queryKey: sportsQueryKeys.leagueTeams(expandedKey ?? ""),
    queryFn: () => getLeagueTeams(expandedKey as string),
    enabled: expandedKey !== null
  });

  // Followed-team chips need club names/crests; the catalog no longer carries rosters after the
  // contract flip, so resolve them via the same per-league roster endpoint (24h-cached,
  // deduped with browse-expand by React Query key) — spec §4.3 (#907).
  const followedTeamComps = [
    ...new Set(follows.filter((f) => f.teamKey !== null).map((f) => f.competitionKey))
  ];
  const rosterQueries = useQueries({
    queries: followedTeamComps.map((key) => ({
      queryKey: sportsQueryKeys.leagueTeams(key),
      queryFn: () => getLeagueTeams(key)
    }))
  });
  const teamsByCompetition = new Map(
    followedTeamComps.map((key, i) => [key, rosterQueries[i]?.data?.teams ?? []])
  );

  const [actionState, setActionState] = useState<FollowActionState>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  function toggle(
    competitionKey: string,
    teamKey: string | null,
    label: string,
    source: FollowActionSource,
    sourceTeamId: string | null = null
  ) {
    const existing = followFor(followsByKey, competitionKey, teamKey, sourceTeamId);
    if (existing) {
      setActionState({
        competitionKey,
        teamKey,
        label,
        direction: "unfollow",
        phase: "pending",
        source
      });
      unfollowMutation.mutate(existing.id, {
        onSuccess: () => setActionState(null),
        onError: () =>
          setActionState({
            competitionKey,
            teamKey,
            label,
            direction: "unfollow",
            phase: "error",
            source
          })
      });
    } else {
      setActionState({
        competitionKey,
        teamKey,
        label,
        direction: "follow",
        phase: "pending",
        source
      });
      followMutation.mutate(
        { competitionKey, teamKey },
        {
          onSuccess: () => setActionState(null),
          onError: () =>
            setActionState({
              competitionKey,
              teamKey,
              label,
              direction: "follow",
              phase: "error",
              source
            })
        }
      );
    }
  }

  return (
    <>
      <PaneHead
        title="Sports"
        desc="Choose what you follow, where your sports news comes from, and which standings you can browse."
      />
      <div className="sp-follow__head">
        <h2 className="jds-section-title">Following</h2>
        <p className="jds-section-sub">
          Follow competitions or teams to see them on your Sports page and in briefings.
        </p>
      </div>
      <FollowedSummary
        follows={follows}
        competitionsByKey={competitionsByKey}
        teamsByCompetition={teamsByCompetition}
        onToggle={toggle}
        actionState={actionState}
      />
      <div className="sp-search">
        <input
          type="search"
          className="sp-search__input"
          aria-label="Find a team or league"
          placeholder="Find a team or league…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {searchEnabled ? (
        <SearchResults
          query={debouncedQuery}
          results={searchQuery.data?.teams ?? []}
          partial={searchQuery.data?.partial === true}
          isError={searchQuery.isError}
          onRetry={() => void searchQuery.refetch()}
          competitions={competitions}
          followsByKey={followsByKey}
          onToggle={toggle}
          actionState={actionState}
        />
      ) : query.length === 1 ? (
        <Note>Search above to find teams or leagues to follow.</Note>
      ) : (
        <>
          <button
            type="button"
            className="sp-browse-toggle"
            aria-expanded={browseOpen}
            aria-controls="sp-browse-panel"
            onClick={() => setBrowseOpen((open) => !open)}
          >
            {browseOpen ? (
              <ChevronDown size={16} aria-hidden="true" />
            ) : (
              <ChevronRight size={16} aria-hidden="true" />
            )}
            Browse leagues
          </button>
          {browseOpen ? (
            <div id="sp-browse-panel">
              <BrowseGroups
                competitions={competitions}
                followsByKey={followsByKey}
                expandedKey={expandedKey}
                onExpand={setExpandedKey}
                expandedTeams={expandedQuery.data?.teams ?? []}
                expandedLoading={expandedQuery.isLoading}
                // Transport failures (network/5xx) leave `data` undefined with isLoading false —
                // without isError here a failed league silently renders as an empty roster grid
                // instead of the retry note (#907 review Important-2).
                expandedDegraded={expandedQuery.data?.degraded === true || expandedQuery.isError}
                onRetryExpanded={() => void expandedQuery.refetch()}
                onToggle={toggle}
                actionState={actionState}
              />
            </div>
          ) : null}
        </>
      )}
      {catalogQuery.isError || followsQuery.isError ? (
        <Note>Could not load sports follows. Try again.</Note>
      ) : null}

      <SportsSourcesSection
        follows={follows}
        competitionsByKey={competitionsByKey}
        teamsByCompetition={teamsByCompetition}
      />
      <StoryPreferencesSection />
      <StandingsLeaguesSection competitions={competitions} />
    </>
  );
}

import { catalogEntry } from "../source/catalog.js";

import type {
  SportsCompletedResult as CompletedResult,
  SportsResultSide as ResultSide
} from "@moss/shared";
export type {
  SportsCompletedResult as CompletedResult,
  SportsResultSide as ResultSide
} from "@moss/shared";

export interface ResultsWindow {
  competitionKey: string;
  sourceTeamId: string;
  from: string;
  to: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200
    ? value.trim()
    : null;
}
function score(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = typeof value === "object" ? object(value).value : value;
  const number =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(number) && number >= 0 && number <= 1000 ? number : null;
}

/** Reuse the reviewed ESPN image origins; no credentials, fragments or arbitrary resources. */
export function resultCrest(value: unknown, imageHosts: readonly string[]): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      imageHosts.includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function side(value: unknown, imageHosts: readonly string[]): ResultSide | null {
  const competitor = object(value);
  const team = object(competitor.team);
  const id = text(team.id);
  const name = text(team.displayName) ?? text(team.shortDisplayName);
  if (!id || !/^\d{1,20}$/.test(id) || !name) return null;
  return {
    id,
    name,
    crestUrl: resultCrest(team.logo ?? object(list(team.logos)[0]).href, imageHosts),
    score: score(competitor.score),
    shootout: score(competitor.shootoutScore),
    aggregate: score(competitor.aggregateScore)
  };
}

/** Completion must be official. A post-state abandoned/cancelled event is not a result. */
export function parseCompletedResults(
  payload: unknown,
  window: ResultsWindow,
  imageHosts: readonly string[]
): CompletedResult[] {
  const entry = catalogEntry(window.competitionKey);
  if (!entry) throw new Error("Unknown result competition");
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const byId = new Map<string, CompletedResult>();
  for (const raw of list(object(payload).events)) {
    const event = object(raw);
    const id = text(event.id);
    const startsAt = text(event.date);
    const instant = startsAt ? Date.parse(startsAt) : NaN;
    const competition = object(list(event.competitions)[0]);
    const status = object(object(competition.status ?? event.status).type);
    if (
      !id ||
      !/^\d{1,20}$/.test(id) ||
      !startsAt ||
      !Number.isFinite(instant) ||
      instant < from ||
      instant > to ||
      status.completed !== true ||
      status.state !== "post" ||
      !/^STATUS_(?:FINAL|FULL_TIME)(?:_|$)/.test(text(status.name) ?? "")
    )
      continue;
    const competitors = list(competition.competitors);
    const homeCandidates = competitors.filter((c) => object(c).homeAway === "home");
    const awayCandidates = competitors.filter((c) => object(c).homeAway === "away");
    if (homeCandidates.length !== 1 || awayCandidates.length !== 1) continue;
    const home = side(homeCandidates[0], imageHosts);
    const away = side(awayCandidates[0], imageHosts);
    if (!home || !away || home.id === away.id || ![home.id, away.id].includes(window.sourceTeamId))
      continue;
    // The schedule may contain another competition. Preserve the event's actual league.
    const league = object(list(event.leagues)[0]);
    const actualKey = text(league.slug) ?? window.competitionKey;
    const actual = catalogEntry(actualKey);
    byId.set(`${entry.espnSport}:${id}`, {
      id,
      sport: entry.espnSport,
      competitionKey: actualKey,
      competition: text(league.name) ?? actual?.label ?? entry.label,
      startsAt: new Date(instant).toISOString(),
      status: text(status.detail) ?? "Final",
      home,
      away
    });
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
}

/** Called only by the declared dataset adapter with the host-pinned fetch capability. */
export async function fetchCompletedResults(
  fetchFn: typeof fetch,
  window: ResultsWindow,
  imageHosts: readonly string[]
): Promise<CompletedResult[]> {
  const entry = catalogEntry(window.competitionKey);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (
    !entry ||
    entry.newsFeedUrl ||
    !/^\d{1,20}$/.test(window.sourceTeamId) ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to < from ||
    to - from > 90 * 86400000
  )
    throw new Error("Invalid bounded results read");
  const dates = `${new Date(from).toISOString().slice(0, 10).replaceAll("-", "")}-${new Date(to).toISOString().slice(0, 10).replaceAll("-", "")}`;
  const url = new URL(
    `https://site.api.espn.com/apis/site/v2/sports/${entry.espnSport}/${entry.espnLeague}/teams/${window.sourceTeamId}/schedule`
  );
  url.searchParams.set("dates", dates);
  url.searchParams.set("limit", "100");
  const response = await fetchFn(url.href, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`ESPN results returned ${response.status}`);
  return parseCompletedResults(await response.json(), window, imageHosts);
}

import type { GameSide, GameSummary, IsoDate, StandingsRow } from "@moss/shared";
import type { ExternalSourceAdapter, ExternalSourceAdapterContext } from "@moss/module-sdk";

import { catalogEntry } from "./catalog.js";
import type { SourceHeadline, SourceTeamRef, StandingsTable } from "./sports-source.js";

// ESPN's unofficial public JSON (no key). Two base hosts are in play: the `site.api`
// host serves scoreboard/news/teams/schedule; standings lives under a different `/apis/v2`
// path on the same host — both paths resolve to the single `site.api.espn.com` fetchHost
// declared on the sports module's `externalSources` manifest entry. Everything is reached only
// through this adapter (LOADER-SEAM(sports)), and only through the runtime's pinned `fetchFn`.
const SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const CORE_BASE = "https://site.api.espn.com/apis/v2/sports";
// Per-article content host (#857). The list `/news` feed omits the article body; the full `story`
// HTML lives only under this host's per-id endpoint. URLs are built from the numeric article id
// (never the provider-supplied `links.api.self.href`) so the fetch target can't be steered — see
// getArticleBody. A THIRD fetchHost, so it must join ESPN_FETCH_HOSTS below (which manifest.ts
// feeds straight into the module's externalSources allowlist) or the runtime blocks the request.
const CONTENT_BASE = "https://content.core.api.espn.com/v1/sports/news";

// Hosts ESPN crest/photo URLs resolve to (team.logos + article images).
// These become the module's CSP img-src allowlist via the manifest's connector `imageHosts`, so a
// host missing here is a silently broken thumbnail, not a fallback. akamaized is ESPN's video-still
// CDN: any story whose art is a video frame (most soccer analysis pieces) serves its image from
// there rather than a.espncdn.com, so soccer cards and the news band showed blank art while the US
// leagues looked fine (Ben 2026-08-01 console report). Adding a host changes the manifest hash —
// the sports module must be redeployed for the new CSP to reach the browser.
export const ESPN_IMAGE_HOSTS: readonly string[] = [
  "a.espncdn.com",
  "s.espncdn.com",
  "s.secure.espncdn.com",
  "espnmedia-cdn.akamaized.net"
];

export const ESPN_FETCH_HOSTS: readonly string[] = [
  "site.api.espn.com",
  "content.core.api.espn.com" // per-article body fetch (#857)
];

// --- Minimal shapes for the fields we read (ESPN payloads carry far more) ------------------

interface EspnCompetitor {
  readonly homeAway?: string;
  readonly winner?: boolean;
  // Scoreboard events carry score as a plain string; the team /schedule endpoint wraps it in
  // an object ({ value, displayValue }) — both shapes are live (verified 2026-07-07).
  readonly score?: string | { readonly value?: number; readonly displayValue?: string };
  readonly team?: {
    readonly id?: string;
    readonly abbreviation?: string;
    readonly displayName?: string;
    readonly shortDisplayName?: string;
    // Scoreboard competitors carry a flat `logo`; the team /schedule endpoint sends a
    // `logos` array instead (verified live 2026-07-07) — both are read in toSide.
    readonly logo?: string;
    readonly logos?: readonly { readonly href?: string }[];
  };
  readonly records?: readonly { readonly summary?: string }[];
  // Hockey scoreboard events carry each side's own "goal leaders" here — see hockeyScorers below
  // for the caveat that this list can be shorter than the actual number of distinct scorers.
  readonly leaders?: readonly {
    readonly name?: string;
    readonly leaders?: readonly {
      readonly displayValue?: string;
      readonly athlete?: { readonly shortName?: string; readonly displayName?: string };
    }[];
  }[];
}

interface EspnEvent {
  readonly id?: string;
  readonly date?: string;
  readonly competitions?: readonly {
    readonly competitors?: readonly EspnCompetitor[];
    readonly status?: { readonly type?: { readonly state?: string; readonly detail?: string } };
    // Soccer scoreboard events carry every scoring play here (one entry per goal) — see
    // soccerScorers below.
    readonly details?: readonly {
      readonly type?: { readonly text?: string };
      readonly team?: { readonly id?: string };
      readonly athletesInvolved?: readonly {
        readonly shortName?: string;
        readonly displayName?: string;
      }[];
    }[];
  }[];
}

interface EspnStandingsEntry {
  readonly team?: {
    readonly id?: string;
    readonly abbreviation?: string;
    readonly displayName?: string;
  };
  readonly note?: { readonly description?: string; readonly color?: string } | null;
  // `displayValue` is read only for the "overall" record stat ("10-2" / "10-2-1") — see
  // overallRecord below.
  readonly stats?: readonly {
    readonly name?: string;
    readonly value?: number;
    readonly displayValue?: string;
  }[];
}

// --- Helpers -------------------------------------------------------------------------------

function resolve(competitionKey: string): { sport: string; league: string } {
  const entry = catalogEntry(competitionKey);
  if (!entry) throw new Error(`unknown competition: ${competitionKey}`);
  return { sport: entry.espnSport, league: entry.espnLeague };
}

// Bounded so `followTeam`'s roster check (sports-service.ts:599-621) can't pin a pooled
// RLS-scoped DB connection on a hung ESPN request indefinitely. A timeout throws an AbortError
// here, which rides the same already-fail-closed path as any other adapter error: it's caught by
// datasets/client.ts's getDataset, degrades to `{ data: [], degraded: true }`, and followTeam
// already rejects on a degraded/empty teams list — no new catch or bypass needed.
const ESPN_FETCH_TIMEOUT_MS = 8_000;

async function fetchJson(fetchFn: typeof fetch, url: string, label: string): Promise<unknown> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(ESPN_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`ESPN ${label} returned ${response.status}`);
  }
  return response.json();
}

function mapState(state: string | undefined): GameSummary["state"] {
  if (state === "in") return "live";
  if (state === "post") return "final";
  return "pre";
}

// Groups a flat list of scorer names into "Name" once, or "Name (2)" for a repeat scorer,
// preserving first-appearance order.
function tallyScorers(names: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([name, count]) =>
    count > 1 ? `${name} (${count})` : name
  );
}

type EspnScoringDetails = NonNullable<NonNullable<EspnEvent["competitions"]>[number]["details"]>;

// Soccer: `competitions[0].details` is a complete list of scoring plays (one entry per goal,
// verified live against ESPN's API). Filter to actual goals for the given team, then tally.
function soccerScorers(
  details: EspnScoringDetails | undefined,
  teamId: string | undefined
): readonly string[] | null {
  const names = (details ?? [])
    .filter((d) => d?.type?.text === "Goal" && d?.team?.id === teamId)
    .flatMap((d) => d?.athletesInvolved ?? [])
    .map((a) => a?.shortName ?? a?.displayName)
    .filter((name): name is string => name != null);
  return names.length === 0 ? null : tallyScorers(names);
}

// Hockey: each competitor carries ESPN's own "goals" leaders category. This is ESPN's "goal
// leaders" list, not a full scoring log, and it can be capped shorter than the number of
// distinct scorers on a team (verified live: Dallas scored 4 goals, only 3 distinct scorers were
// listed) — so a team with several different scorers may show one fewer name than goals scored.
// That is a gap in what the provider hands back, not a bug in this parsing.
function hockeyScorers(leaders: EspnCompetitor["leaders"]): readonly string[] | null {
  const goals = (leaders ?? []).find((category) => category?.name === "goals");
  const names = (goals?.leaders ?? [])
    .map((leader) => {
      const name = leader?.athlete?.shortName ?? leader?.athlete?.displayName;
      if (name == null) return null;
      const count = Number(leader.displayValue);
      return count > 1 ? `${name} (${count})` : name;
    })
    .filter((name): name is string => name != null);
  return names.length === 0 ? null : names;
}

function toSide(
  competitor: EspnCompetitor | undefined,
  scorers: readonly string[] | null
): GameSide {
  const team = competitor?.team;
  const teamKey = (team?.abbreviation ?? team?.id ?? "").toLowerCase();
  // Object-shaped scores come from the /schedule endpoint; Number({...}) is NaN, which used to
  // null every schedule score — soccer draws then fell through resultOf()'s winner check and
  // rendered as losses in the form pips (live feedback mrawhx9c).
  const scoreRaw = competitor?.score;
  const scoreValue = typeof scoreRaw === "object" ? scoreRaw.value : scoreRaw;
  const score = scoreValue === undefined || scoreValue === "" ? null : Number(scoreValue);
  return {
    teamKey,
    name: team?.displayName ?? teamKey,
    shortName: team?.shortDisplayName ?? team?.displayName ?? teamKey,
    // `logo` on scoreboard payloads, `logos[0].href` on schedule payloads — without the
    // fallback every schedule-derived side had a null crest, so the ticker footer's opponent
    // logo (mrawvc48) silently degraded to the initials swatch.
    crestUrl: team?.logo ?? team?.logos?.[0]?.href ?? null,
    score: score === null || Number.isNaN(score) ? null : score,
    record: competitor?.records?.[0]?.summary ?? null,
    winner: competitor?.winner === true,
    scorers
  } satisfies GameSide;
}

function toGame(event: EspnEvent, competitionKey: string): GameSummary {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === "home") ?? competitors[0];
  const away = competitors.find((c) => c.homeAway === "away") ?? competitors[1];
  const type = competition?.status?.type;
  // Safe to call here: getScoreboard already calls resolve() on the same competitionKey before
  // toGame runs, so an unknown key would have thrown there first.
  const { sport } = resolve(competitionKey);
  const scorersFor = (c: EspnCompetitor | undefined): readonly string[] | null => {
    if (sport === "soccer") return soccerScorers(competition?.details, c?.team?.id);
    if (sport === "hockey") return hockeyScorers(c?.leaders);
    return null;
  };
  return {
    id: event.id ?? "",
    competitionKey,
    startsAt: event.date ?? "",
    state: mapState(type?.state),
    statusDetail: type?.detail ?? "",
    home: toSide(home, scorersFor(home)),
    away: toSide(away, scorersFor(away))
  };
}

function statValue(
  stats: readonly { readonly name?: string; readonly value?: number }[] | undefined,
  name: string
): number | undefined {
  return stats?.find((s) => s.name === name)?.value;
}

// ESPN ships malformed note colors — the Premier League Europa slot arrives as "##B5E7CE"
// (double hash, verified live 2026-07-07). Injected raw into color-mix() that invalidates the
// whole declaration, so Europa rows silently lost their zone tint while CL/relegation rows kept
// theirs (live feedback mrb4sa8y). Normalize to one "#" and hard-validate the hex; anything
// unparseable becomes null so the web layer's neutral fallback takes over. This is also the
// safety valve for feeding a provider-supplied string into inline styles.
function normalizeNoteColor(color: string | undefined): string | null {
  if (!color) return null;
  const hex = `#${color.replace(/^#+/, "")}`;
  return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex) ? hex : null;
}

// College football standings (?level=3, verified live 2026-09-03) carry a "wins" stat but NO
// "losses", "ties" or "winPercent" stats — the only place the losses live is the "overall"
// record string ("1-0", "10-2-1"). Without this fallback every FBS team reads as undefeated.
// Pro leagues carry the numeric stats and never reach the fallback.
function overallRecord(
  stats: EspnStandingsEntry["stats"]
): { wins: number; losses: number; ties: number | null } | null {
  const text = stats?.find((s) => s.name === "overall")?.displayValue;
  const match = text ? /^(\d+)-(\d+)(?:-(\d+))?$/.exec(text.trim()) : null;
  if (!match) return null;
  return {
    wins: Number(match[1]),
    losses: Number(match[2]),
    ties: match[3] === undefined ? null : Number(match[3])
  };
}

function toStandingsRow(entry: EspnStandingsEntry, index: number): StandingsRow {
  const teamKey = (entry.team?.abbreviation ?? entry.team?.id ?? "").toLowerCase();
  const overall = overallRecord(entry.stats);
  const wins = statValue(entry.stats, "wins") ?? overall?.wins ?? 0;
  const losses = statValue(entry.stats, "losses") ?? overall?.losses ?? 0;
  const draws = statValue(entry.stats, "ties") ?? overall?.ties ?? null;
  const played = wins + losses + (draws ?? 0);
  return {
    teamKey,
    name: entry.team?.displayName ?? teamKey,
    // US record leagues at ?level=3 carry NO "rank" stat on division entries (verified live
    // 2026-07-07) but arrive standings-sorted, so the position in the section IS the rank.
    // The old `?? 0` fallback produced "#0 · 10-2" lines the web sanity guard then hid on
    // every card (live feedback mraxrdxr, mraz6m43).
    rank: statValue(entry.stats, "rank") ?? index + 1,
    points: statValue(entry.stats, "points") ?? null,
    wins,
    losses,
    draws,
    winPercent:
      statValue(entry.stats, "winPercent") ??
      (overall && played > 0 ? (wins + (draws ?? 0) / 2) / played : null),
    qualifies: entry.note != null,
    qualificationNote: entry.note?.description ?? null,
    qualificationColor: normalizeNoteColor(entry.note?.color)
  };
}

// --- Per-dataset fetchers --------------------------------------------------------------------
// Params below are validated only by shape (the dataset runtime's params are untyped
// `Record<string, unknown>`, per the connector SDK's `ExternalSourceAdapter` contract); the
// module's own service layer is the trusted caller and always passes the fields declared here.

export interface EspnTeamsParams {
  readonly competitionKey: string;
}

export interface EspnScoreboardParams {
  readonly competitionKey: string;
  readonly day: IsoDate;
  // When present, the scoreboard is fetched over the inclusive `day`..`endDay` range instead of
  // the single `day` (ESPN accepts `dates=YYYYMMDD-YYYYMMDD`) — used for tournament fixtures
  // that span several days (#839 follow-up).
  readonly endDay?: IsoDate;
}

export interface EspnScheduleParams {
  readonly teamKey: string;
  readonly competitionKey: string;
  // ESPN numeric team id from the teams catalog. Soccer leagues do NOT resolve abbreviation
  // slugs on the schedule endpoint (/soccer/usa.1/teams/sd/schedule → empty payload, verified
  // live 2026-07-07) while the numeric id works for every sport — so this is preferred over
  // teamKey whenever the catalog has it (live feedback mrawhx9c: soccer cards had no form).
  readonly sourceTeamId?: string | null;
}

export interface EspnStandingsParams {
  readonly competitionKey: string;
}

export interface EspnHeadlinesParams {
  readonly competitionKey: string;
  /** ESPN team slug — narrows the news feed to one team (`?team=sf`). */
  readonly teamKey?: string;
  // Same abbreviation-slug trap as EspnScheduleParams, on the news endpoint this time: soccer
  // rejects the slug outright — /soccer/eng.1/news?team=ars answers HTTP 400 with a binary body
  // (verified live 2026-08-01) while ?team=359 returns that club's stories. The throw fell back to
  // an empty team feed, and the 6-article league feed rarely files under a specific club, so every
  // soccer card read "No recent news" mid-season (Ben /sports feedback 2026-08-01). The numeric id
  // is accepted by the US leagues too (mlb ?team=26 === ?team=sf), so it is simply preferred.
  readonly sourceTeamId?: string | null;
}

async function listTeams(fetchFn: typeof fetch, params: EspnTeamsParams): Promise<SourceTeamRef[]> {
  const { competitionKey } = params;
  const { sport, league } = resolve(competitionKey);
  // ESPN pages the teams list at 50 by default. Pro leagues fit, but the college leagues added
  // for #2210 run to hundreds (college-football answers 760, mens-college-basketball 362, verified
  // live 2026-09-03), and the default page started at "Abilene Christian", so Alabama, Ohio State
  // and every other major program were unfollowable. Ask for everything in one page.
  const data = (await fetchJson(
    fetchFn,
    `${SITE_BASE}/${sport}/${league}/teams?limit=1000`,
    `${league} teams`
  )) as {
    sports?: readonly {
      leagues?: readonly {
        teams?: readonly {
          team?: {
            id?: string;
            abbreviation?: string;
            displayName?: string;
            shortDisplayName?: string;
            logos?: readonly { href?: string }[];
          };
        }[];
      }[];
    }[];
  };
  const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams.map(({ team }) => {
    const teamKey = (team?.abbreviation ?? team?.id ?? "").toLowerCase();
    return {
      teamKey,
      competitionKey,
      name: team?.displayName ?? teamKey,
      shortName: team?.shortDisplayName ?? team?.displayName ?? teamKey,
      crestUrl: team?.logos?.[0]?.href ?? null,
      sourceTeamId: team?.id ?? null
    } satisfies SourceTeamRef;
  });
}

async function getScoreboard(
  fetchFn: typeof fetch,
  params: EspnScoreboardParams
): Promise<GameSummary[]> {
  const { competitionKey, day, endDay } = params;
  const { sport, league } = resolve(competitionKey);
  const start = day.replace(/-/g, "");
  const dates = endDay ? `${start}-${endDay.replace(/-/g, "")}` : start;
  const data = (await fetchJson(
    fetchFn,
    `${SITE_BASE}/${sport}/${league}/scoreboard?dates=${dates}`,
    `${league} scoreboard`
  )) as { events?: readonly EspnEvent[] };
  return (data.events ?? []).map((event) => toGame(event, competitionKey));
}

async function getSchedule(
  fetchFn: typeof fetch,
  params: EspnScheduleParams
): Promise<GameSummary[]> {
  const { teamKey, competitionKey } = params;
  const { sport, league } = resolve(competitionKey);
  // Numeric id first — the abbreviation slug 404s-to-empty on soccer schedule URLs (see
  // EspnScheduleParams.sourceTeamId); teamKey stays as the fallback for callers without a
  // catalog in hand.
  // Percent-encoded because this is the outbound sink for a key that can originate in an
  // assistant tool call (#1265 security QA BLOCKING-1c): the value must stay inside its own path
  // segment no matter what upstream validation did or didn't catch. `getHeadlines` below already
  // encodes its query-string use of teamKey; this is the same rule for the path use. Catalog-clean
  // keys ("nfl", "dal", "22529") are unchanged by encoding, so this is invisible in practice.
  const pathKey = encodeURIComponent(params.sourceTeamId ?? teamKey);
  const data = (await fetchJson(
    fetchFn,
    `${SITE_BASE}/${sport}/${league}/teams/${pathKey}/schedule`,
    `${league} schedule`
  )) as { events?: readonly EspnEvent[] };
  return (data.events ?? []).map((event) => toGame(event, competitionKey));
}

// `?level=3` nests conference nodes (which carry no entries of their own) above the division
// nodes that do (verified live: NFL → American/National Football Conference → AFC East ×4 teams;
// soccer stays flat with no children). We walk the tree collecting every node that has
// `standings.entries` as one section, tagging it with the nearest ancestor that had children but
// no entries (the conference); flat leagues fall through with `conference: null`.
interface EspnStandingsNode {
  readonly name?: string;
  readonly abbreviation?: string;
  readonly standings?: { entries?: readonly EspnStandingsEntry[] };
  readonly children?: readonly EspnStandingsNode[];
}

type StandingsSectionRaw = {
  label: string | null;
  conference: string | null;
  rows: StandingsRow[];
};

function collectStandingsSections(
  node: EspnStandingsNode,
  conference: string | null,
  depth: number,
  out: StandingsSectionRaw[]
): void {
  const entries = node.standings?.entries ?? [];
  if (entries.length > 0) {
    out.push({
      label: node.name ?? node.abbreviation ?? null,
      conference,
      rows: entries.map(toStandingsRow)
    });
  }
  const children = node.children ?? [];
  // A non-root node with children but no entries of its own is a grouping level (a conference);
  // its label becomes the `conference` tag for everything beneath it. The top-level root is never
  // a conference ("null at top level"), so soccer group stages (Group A…H under the root) stay
  // flat with no conference tag.
  const childConference =
    depth > 0 && entries.length === 0 ? (node.name ?? node.abbreviation ?? conference) : conference;
  for (const child of children) {
    collectStandingsSections(child, childConference, depth + 1, out);
  }
}

async function getStandings(
  fetchFn: typeof fetch,
  params: EspnStandingsParams
): Promise<StandingsTable> {
  const { competitionKey } = params;
  const { sport, league } = resolve(competitionKey);
  const data = (await fetchJson(
    fetchFn,
    `${CORE_BASE}/${sport}/${league}/standings?level=3`,
    `${league} standings`
  )) as EspnStandingsNode;
  const sections: StandingsSectionRaw[] = [];
  collectStandingsSections(data, null, 0, sections);
  return { sections: sections.filter((section) => section.rows.length > 0) };
}

async function getHeadlines(
  fetchFn: typeof fetch,
  params: EspnHeadlinesParams
): Promise<SourceHeadline[]> {
  const { competitionKey, teamKey } = params;
  const { sport, league } = resolve(competitionKey);
  // Numeric id first, slug as the fallback for callers without a catalog in hand — see
  // EspnHeadlinesParams.sourceTeamId. Still percent-encoded: this is an outbound sink for a key
  // that can originate in an assistant tool call (#1265 security QA BLOCKING-1c).
  const teamParam = params.sourceTeamId ?? teamKey;
  const teamFilter = teamParam ? `?team=${encodeURIComponent(teamParam)}` : "";
  const data = (await fetchJson(
    fetchFn,
    `${SITE_BASE}/${sport}/${league}/news${teamFilter}`,
    `${league} news`
  )) as {
    articles?: readonly {
      id?: number | string;
      headline?: string;
      description?: string;
      published?: string;
      links?: { web?: { href?: string } };
      images?: readonly { type?: string; url?: string }[];
      categories?: readonly { type?: string; teamId?: number | string }[];
    }[];
  };
  const competition = catalogEntry(competitionKey);
  if (!competition) throw new Error(`Unknown sports competition: ${competitionKey}`);
  return (data.articles ?? []).map((article, index) => {
    const images = article.images ?? [];
    const image = images.find((i) => i.type === "header" && i.url) ?? images.find((i) => i.url);
    return {
      origin: "espn",
      id: String(article.id ?? index),
      sportKey: competition.espnSport,
      competitionKey,
      competitionLabel: competition.label,
      title: article.headline ?? "",
      url: article.links?.web?.href ?? "",
      publishedAt: article.published ?? "",
      imageUrl: image?.url ?? null,
      summary: article.description ?? "",
      teamKeys: [],
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: (article.categories ?? [])
        .filter((c) => c.type === "team" && c.teamId != null)
        .map((c) => String(c.teamId))
    };
  });
}

// --- Per-article body (#857) ---------------------------------------------------------------
// The NewsBand featured hero underfills with only the one-paragraph dek. The full body lives on
// the per-article content host; we fetch it for the SINGLE featured story and sanitize the HTML
// down to plaintext BEFORE it leaves this layer, so the web tier renders inert text and never
// ESPN markup. See spec on issue #857.

export interface EspnArticleBodyParams {
  // ESPN numeric article id (the `id` set on each SourceHeadline in getHeadlines). The fetch URL
  // is built from this — never from a provider-supplied href — so a poisoned payload can't steer
  // the request to another host/path (SSRF hardening, #857).
  readonly articleId: string;
}

// Decode the small set of HTML entities ESPN actually emits in story bodies (named + numeric).
// Deliberately narrow: we're producing plaintext for text rendering, not a general HTML decoder.
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;|&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m: string, code: string) => codePointOr(Number(code), m))
    .replace(/&#x([0-9a-fA-F]+);/g, (m: string, code: string) =>
      codePointOr(parseInt(code, 16), m)
    );
}

// String.fromCodePoint throws RangeError on a value above U+10FFFF (or a lone surrogate), and the
// caller's catch would then drop the ENTIRE article body over one malformed entity (Fable L2). An
// out-of-range codepoint keeps its literal source text instead — lossless and never throwing.
function codePointOr(n: number, original: string): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return original;
  }
  return String.fromCodePoint(n);
}

// Cap length AND turn ESPN story HTML into safe plaintext (#857). This is the core injection
// mitigation: after this runs there are zero tags/tokens left, so the web layer rendering it as
// React text ({string}) can't emit any ESPN-controlled markup or `<photoN>` embed. Exported so
// the unit suite can assert "zero surviving tags" directly against real fixtures.
const BODY_CHAR_CAP = 900; // ~3 short paragraphs; keeps the hero filled without over-fetching text
const MAX_BODY_PARAGRAPHS = 3;

export function sanitizeArticleBody(story: string | undefined | null): string {
  if (!story) return "";
  // Pull the first few <p> blocks — ESPN wraps every body paragraph in <p>; anything outside them
  // (photo embeds, promo rails) is chrome we don't want in the hero.
  const paragraphs: string[] = [];
  const paragraphRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = paragraphRe.exec(story)) !== null && paragraphs.length < MAX_BODY_PARAGRAPHS) {
    const plain = decodeEntities(
      (match[1] ?? "") // capture group always present on a match; ?? satisfies noUncheckedIndexedAccess
        .replace(/<[^>]+>/g, "") // strip inline tags (<a> <i> <b> …) inside the paragraph
        .replace(/\s+/g, " ")
    ).trim();
    // Drop `<photoN>` placeholder tokens and any residual angle-bracket debris, then re-check empty.
    const cleaned = plain
      .replace(/<\s*photo\d+\s*>/gi, "")
      .replace(/[<>]/g, "")
      .trim();
    if (cleaned) paragraphs.push(cleaned);
  }
  // Fallback: some stories carry no <p> wrappers — flatten the whole thing so we still get text.
  if (paragraphs.length === 0) {
    const flat = decodeEntities(story.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))
      .replace(/<\s*photo\d+\s*>/gi, "")
      .replace(/[<>]/g, "")
      .trim();
    if (flat) paragraphs.push(flat);
  }
  const joined = paragraphs.join("\n\n");
  if (joined.length <= BODY_CHAR_CAP) return joined;
  // Cap at a word boundary so we don't slice mid-word, then append an ellipsis.
  const clipped = joined.slice(0, BODY_CHAR_CAP);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > BODY_CHAR_CAP * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

async function getArticleBody(
  fetchFn: typeof fetch,
  params: EspnArticleBodyParams
): Promise<string> {
  // Validate BEFORE building the URL: real ESPN article ids are multi-digit numerics. `^\d{4,}$`
  // both hardens the fetch target (only a bare number can reach the URL — no host/path/query
  // injection) AND excludes the index-fallback ids getHeadlines assigns when an article has no id
  // (`String(index)`, 1–3 digits for overview-sized lists) — those aren't real articles, so
  // there's nothing to fetch.
  if (!/^\d{4,}$/.test(params.articleId)) return "";
  try {
    const data = (await fetchJson(
      fetchFn,
      `${CONTENT_BASE}/${params.articleId}`,
      "article body"
    )) as { headlines?: readonly { story?: string }[] };
    return sanitizeArticleBody(data.headlines?.[0]?.story);
  } catch {
    // Graceful degrade (#857): any failure (404 on a stale id, timeout, malformed JSON) → no body,
    // and the UI falls back to the dek. The body must NEVER block or fail the overview render.
    return "";
  }
}

// --- Adapter (the `ExternalSourceAdapter` implementation the dataset runtime dispatches to) --

const ESPN_DATASET_KEYS = [
  "teams",
  "scoreboard",
  "schedule",
  "standings",
  "headlines",
  "articleBody" // per-article body for the featured hero only (#857)
] as const;
type EspnDatasetKey = (typeof ESPN_DATASET_KEYS)[number];

function isEspnDatasetKey(value: string): value is EspnDatasetKey {
  return (ESPN_DATASET_KEYS as readonly string[]).includes(value);
}

export function createEspnDatasetAdapter(): ExternalSourceAdapter {
  return {
    async fetchDataset(
      datasetKey: string,
      params: Record<string, unknown>,
      ctx: ExternalSourceAdapterContext
    ): Promise<unknown> {
      if (!isEspnDatasetKey(datasetKey)) {
        throw new Error(`ESPN adapter: unknown dataset "${datasetKey}"`);
      }
      switch (datasetKey) {
        case "teams":
          return listTeams(ctx.fetchFn, params as unknown as EspnTeamsParams);
        case "scoreboard":
          return getScoreboard(ctx.fetchFn, params as unknown as EspnScoreboardParams);
        case "schedule":
          return getSchedule(ctx.fetchFn, params as unknown as EspnScheduleParams);
        case "standings":
          return getStandings(ctx.fetchFn, params as unknown as EspnStandingsParams);
        case "headlines":
          return getHeadlines(ctx.fetchFn, params as unknown as EspnHeadlinesParams);
        case "articleBody":
          // Featured-hero body only (#857). Returns "" on any failure so the caller falls back
          // to the dek — never throws, never blocks the overview.
          return getArticleBody(ctx.fetchFn, params as unknown as EspnArticleBodyParams);
      }
    }
  };
}

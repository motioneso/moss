// external-modules/job-search/src/web/board-types.ts
// Task 20 (#1304): wire-shape types for job-search.matches.list and job-search.portal.list,
// shared between screens/board.tsx and screens/inspector.tsx so neither screen file imports the
// other (the 1000-line file-size cap is why board and inspector are two files at all — see
// check:file-size). Mirrors use-profiles.ts's own stance: these describe what actually crosses
// the wire, not the domain's Match/PortalState directly. The matches.list handler
// (worker/handlers/matches.ts's BoardMatch) drops fields the board never needs (profileId,
// postingId, scoredAt) and adds two it does (title/company, joined in from Posting) — so
// re-declaring the shape here, rather than importing domain Match, is deliberate.
import type { FailureCause } from "../domain/records.js";
import { FIT_BAND_MINIMUMS } from "../domain/score.js";

export type MatchState = "unscored" | "new" | "seen" | "dismissed";

// N39: no fitReason/wantReason here — board.tsx's table never renders them (a field belongs on
// the list row only if the list renders it), so they don't belong on this wire shape at all, not
// merely truncated. `url` stays: it's per-row real data the row uses directly (the inspector's
// "Open posting" link), not detail-only prose. The full reasons live on `MatchDetail` below,
// fetched separately by job-search.match.get when a row is opened.
export interface BoardMatch {
  id: string;
  title: string;
  company: string;
  fit: number | null;
  want: number | null;
  outsideFrame: boolean;
  state: MatchState;
  url: string;
  // The card's meta line. These are not "extra detail" in the sense N39 rejected — they are short
  // structured facts the card renders directly, which is the test N39 actually sets. `postedAt` is
  // the raw instant; the module has no ambient clock, so no relative "3 days ago" is computed.
  location: string;
  source: string;
  postedAt: string | null;
}

const MATCH_STATES: ReadonlySet<string> = new Set(["unscored", "new", "seen", "dismissed"]);

/** True only when `value` has every field BoardMatch claims, with the right runtime type (#1336).
 * This is the board's one check on job-search.matches.list's wire shape — every field is required
 * and type-checked, and nothing here substitutes a default for a missing field, because a
 * substituted default would hide the exact drift this check exists to catch. */
export function isBoardMatch(value: unknown): value is BoardMatch {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.company === "string" &&
    (typeof v.fit === "number" || v.fit === null) &&
    (typeof v.want === "number" || v.want === null) &&
    typeof v.outsideFrame === "boolean" &&
    typeof v.state === "string" &&
    MATCH_STATES.has(v.state) &&
    typeof v.url === "string" &&
    typeof v.location === "string" &&
    typeof v.source === "string" &&
    (typeof v.postedAt === "string" || v.postedAt === null)
  );
}

// #1330: mirrors worker/handlers/matches.ts's MatchDetail — the untruncated record behind
// job-search.match.get, fetched by board.tsx when a row is selected and handed to the inspector
// as its own prop (never fetched by the inspector itself; see that file's header for why). A
// separate type from BoardMatch, not BoardMatch-plus-fields, because it's exempt from the
// render-cap/row-count arithmetic that shapes the list row — this is always exactly one record.
export interface MatchDetail {
  id: string;
  title: string;
  company: string;
  url: string;
  body: string;
  fit: number | null;
  want: number | null;
  fitReason: string;
  wantReason: string;
  outsideFrame: boolean;
  scoredAt: string | null;
  state: MatchState;
}

// portal.list's result (worker/handlers/portal.ts's createPortalListHandler) — `cause` is the
// real domain FailureCause, unmodified end to end, which is exactly why it's safe to reuse that
// type here instead of re-declaring it: the handler returns `portal.cause` verbatim.
export interface PortalListItem {
  sourceId: string;
  label: string;
  enabled: boolean;
  lastOkAt: string | null;
  cause: FailureCause | null;
}

// A type predicate rather than a plain boolean so callers that render or compare the numbers get
// them as `number` instead of re-asserting non-null at every use — the guard already proves it,
// and a `!` at the use site would be an unchecked claim sitting next to a checked one.
//
// "Read" is keyed on WANT, not on both axes. Fit is judged against the résumé, so a match read
// before one was uploaded carries `fit: null` — a real, scored row with one axis it had no basis
// to answer. Requiring both would file that row under "not read yet", which is a different and
// wrong claim: it was read, and the Want number beside it was genuinely reasoned about. Want is
// the axis that is always answerable, because activation already requires the sentence it is
// judged against. Callers render Fit through an explicit `item.fit === null` branch — the guard
// deliberately no longer narrows it, so the compiler asks the question at every use site.
export function isScored(item: BoardMatch): item is BoardMatch & { want: number } {
  return item.state !== "unscored" && item.want !== null;
}

export type MatchBucket = "unreviewed" | "saved" | "passed";

export function matchBucket(item: BoardMatch): MatchBucket {
  if (item.state === "seen") return "saved";
  if (item.state === "dismissed") return "passed";
  return "unreviewed";
}

export type FitFilter = "any" | "strong" | "good" | "fair" | "weak" | "unscored";
export type PostedFilter = "any" | "day" | "week" | "month";

export interface BoardFilters {
  query: string;
  location: string;
  posted: PostedFilter;
  fit: FitFilter;
  source: string;
}

export const EMPTY_BOARD_FILTERS: BoardFilters = {
  query: "",
  location: "",
  posted: "any",
  fit: "any",
  source: ""
};

function fitFilterFor(value: number | null): FitFilter {
  if (value === null) return "unscored";
  if (value >= FIT_BAND_MINIMUMS.strong) return "strong";
  if (value >= FIT_BAND_MINIMUMS.good) return "good";
  if (value >= FIT_BAND_MINIMUMS.fair) return "fair";
  return "weak";
}

export function filterBoardMatches(
  items: readonly BoardMatch[],
  filters: BoardFilters,
  nowMs: number
): BoardMatch[] {
  const query = filters.query.trim().toLowerCase();
  const location = filters.location.trim().toLowerCase();
  const source = filters.source.trim().toLowerCase();
  const postedWindow =
    filters.posted === "day"
      ? 86_400_000
      : filters.posted === "week"
        ? 604_800_000
        : filters.posted === "month"
          ? 2_592_000_000
          : null;

  return items.filter((item) => {
    if (
      query &&
      !item.title.toLowerCase().includes(query) &&
      !item.company.toLowerCase().includes(query)
    ) {
      return false;
    }
    if (location && !item.location.toLowerCase().includes(location)) return false;
    if (source && item.source.toLowerCase() !== source) return false;
    if (filters.fit !== "any" && fitFilterFor(item.fit) !== filters.fit) return false;
    if (postedWindow !== null) {
      if (!item.postedAt) return false;
      const postedAt = Date.parse(item.postedAt);
      if (!Number.isFinite(postedAt) || postedAt > nowMs || nowMs - postedAt > postedWindow) {
        return false;
      }
    }
    return true;
  });
}

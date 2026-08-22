// external-modules/job-search/src/worker/handlers/matches.ts
//
// Task 15 (#1299): matches.list and match.set-state — the board's only route to the database.
// Until these are registered, `apps/web/src/external-modules/loader.ts` hands the web bundle
// only `{hostActions, assistantSurface?}` and it has no database access of any kind.
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import { capPostingBody, MATCHES_LIST_MAX_LIMIT } from "../../domain/records.js";
import type { Match } from "../../domain/records.js";
import type { JobSearchStore } from "../../domain/store-port.js";
import { fetchLinkedInDescription } from "../../adapters/linkedin.js";
import type { FetchLike } from "../../adapters/types.js";
import { looksLikeJobEnvelope, parseJobEnvelope } from "../job-input.js";
import { labelFor } from "./portal.js";
import { InputError, stripEnvelope } from "../validate.js";

// Ruling N5: the board's REST route ends at `boundedAssistantToolResultData`
// (packages/ai/src/routes.ts), which THROWS AWAY the structured result and substitutes
// `{text: "…truncated"}` once the rendered form passes 16 000 characters. A board that hits that
// substitution has no matches to render at all, not a short list — so every constant below is
// bounded by that render cap, not by taste, and `MATCHES_LIST_MAX_LIMIT` is re-checked here even
// though `limit`'s schema maximum is also lowered in jarvis.module.json: the queue path's params
// DSL has no numeric bounds and never validates it, so a handler that trusted the schema alone
// would accept an unbounded board read from a manually-run job.
//
// `renderToolResult` (packages/module-sdk/src/index.ts) renders a uniform flat array of scalar
// fields as a markdown table, not `JSON.stringify` — every field is a table cell, so a single
// unbounded string field (a scraped posting's title, or its company name) is just as capable of
// blowing the render cap as an unbounded reason. `title`/`company` come straight from a crawled
// posting, which this module does not control the length of, so they get the same treatment.
//
// See tests/unit/job-search-match-handler.test.ts's worst-case render-survival test for the
// arithmetic these were tuned against — every text field (including `url`) at its cap, rendered
// through the real markdown-table format, targeting <=80% of the 16 000-char cap rather than
// merely under it, so a field added later doesn't silently blow the budget.
//
// N39 ("a field belongs in the list row only if the list renders it"): `board.tsx` never renders
// `fitReason`/`wantReason` — the table shows Fit/Want as sortable numeric columns only, and the
// only reason-consumer is the inspector, open for one match at a time behind `job-search.match.get`
// (#1330, below). Reasons are therefore gone from `BoardMatch` entirely, not merely re-truncated;
// `REASON_MAX_CHARS` no longer exists here because there is nothing left in this row to bound.
//
// N43: `MATCHES_LIST_MAX_LIMIT` used to be declared here as its own literal, with `board.tsx`
// carrying a second literal that had to be kept equal by hand — a999a081 proved that discipline
// alone doesn't hold under a concurrent multi-agent tree (the handler shipped 25, board.tsx still
// asked for 40, and `requireLimit` below threw `InputError` on every board read). It is now a
// single exported constant in `../../domain/records.js`, imported here and by `board.tsx` — see
// that file for the render-cap arithmetic behind the value 25 (measured true ceiling: 30 rows,
// <=80% of the 16 000-char render cap; see tests/unit/job-search-match-handler.test.ts's worst-case
// render-survival test).
export const TITLE_MAX_CHARS = 80;
export const COMPANY_MAX_CHARS = 60;
// N39 also asked whether `URL_MAX_CHARS` truncation is still earning its keep now that the reason
// budget is freed — checked, not assumed: an untruncated worst-case URL (2000 chars, a generous
// ceiling browsers/servers commonly reject past) renders at ~209% of the cap at only 15 rows, so
// dropping truncation is not affordable at any plausible row count. It stays.
//
// Real crawled/custom posting URLs are far shorter than this in practice (linkedin.ts strips
// tracking query params before storage) — this cap exists for the render-survival worst case,
// not because a legitimate URL is expected to approach it. Unlike a truncated title or reason, a
// truncated URL is not a shorter version of a working link; it is a broken one. That is an
// accepted, rare degradation against the alternative (a board that renders no rows at all above
// the render cap), not a claim that a cut-off link is still useful.
export const URL_MAX_CHARS = 200;

// Added after the board became a card list and read as empty — a card has room a table cell did
// not, and these three were already on `Posting`, just never crossing the wire. They are bounded
// by the same render-cap arithmetic as everything above, so they were costed before being added
// rather than after: the row was spending ~406 chars of a ~512 budget (25 rows against 80% of the
// 16 000-char cap), and location+source+postedAt at these caps add ~70, landing near 476. That
// is deliberately the whole remaining budget — it is why a `wantReason` snippet is NOT here
// alongside them (N39 stands; ~110 more chars a row does not fit, and over the cap the board
// renders zero rows rather than short ones).
//
// `postedAt` is an ISO instant off the record, not a computed "3 days ago" — the module has no
// ambient-clock allowance (check:no-ambient-dates), and formatting it relatively here would be
// exactly that. The card renders the date itself.
export const LOCATION_MAX_CHARS = 40;
export const SOURCE_LABEL_MAX_CHARS = 24;

/** Enforced in the handler because the queue's params DSL has no enum for `state` and the
 * manifest's own `paramsSchema` fix (an `enum` type) still leaves the manual-run body path,
 * which the platform never re-validates against `jarvis.module.json` at request time. Does not
 * include `"unscored"` — that is a scoring precondition a user never sets directly. */
export const SETTABLE_STATES = ["new", "seen", "dismissed"] as const;
const SETTABLE_STATES_SET: ReadonlySet<string> = new Set(SETTABLE_STATES);

const MATCHES_LIST_KEYS = new Set(["profileId", "limit", "offset"]);

// N39: no `fitReason`/`wantReason` here — `board.tsx` never renders them (verified by grep, not
// assumed), so they don't belong on the row's type at all. They live only on `MatchDetail`, below.
export interface BoardMatch {
  id: string;
  title: string;
  company: string;
  fit: number | null;
  want: number | null;
  outsideFrame: boolean;
  state: Match["state"];
  url: string;
  location: string;
  source: string;
  postedAt: string | null;
}

// #1330: the untruncated detail behind job-search.match.get, opened when the inspector needs
// the full reason a BoardMatch row can't carry (as of N39, can't carry at all, not just
// truncated). Deliberately not `BoardMatch` plus fields — keeping it a separate type documents
// that this shape is exempt from the row-count/render-cap arithmetic above (one record, not up
// to fifteen, so nothing here needs `truncateText`).
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
  state: Match["state"];
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const REQUIRED_NONEMPTY_FIELDS = ["id", "title", "company", "url", "location", "source"] as const;
const KNOWN_STATES: ReadonlySet<string> = new Set(["unscored", "new", "seen", "dismissed"]);

/** Field names only — never call this with anything that logs the item itself. */
function malformedBoardMatchFields(item: BoardMatch): string[] {
  const bad: string[] = [];
  for (const field of REQUIRED_NONEMPTY_FIELDS) {
    if (typeof item[field] !== "string" || item[field].length === 0) bad.push(field);
  }
  if (!KNOWN_STATES.has(item.state)) bad.push("state");
  return bad;
}

function requireProfileId(input: Record<string, unknown>): string {
  const value = input.profileId;
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError("profileId is required");
  }
  return value;
}

/** No default — an omitted, zero, fractional, or over-cap `limit` all throw. A handler that
 * silently substituted a default the first time this was raised is how an unbounded board read
 * ships as an omission instead of a failure someone notices. */
function requireLimit(input: Record<string, unknown>): number {
  const value = input.limit;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MATCHES_LIST_MAX_LIMIT
  ) {
    throw new InputError(`limit must be an integer between 1 and ${MATCHES_LIST_MAX_LIMIT}`);
  }
  return value;
}

/** Unlike `limit`, `offset` IS optional and defaults to 0 — the assistant calls this tool too, and
 * "the first page" is the only thing a model asking for matches ever means. A present-but-invalid
 * offset still throws: a silently-corrected one would return page one while the caller believed it
 * had page four, which reads as a board that repeats itself rather than as a failure. No upper
 * bound: `limit` alone bounds the response size, and there is nothing to protect past the last
 * row — an offset beyond the end simply returns nothing. */
function readOffset(input: Record<string, unknown>): number {
  const value = input.offset;
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InputError("offset must be an integer of 0 or more");
  }
  return value;
}

function requireMatchId(input: Record<string, unknown>): string {
  const value = input.matchId;
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError("matchId is required");
  }
  return value;
}

function requireSettableState(value: unknown): Match["state"] {
  if (typeof value !== "string" || !SETTABLE_STATES_SET.has(value)) {
    throw new InputError(`state must be one of: ${SETTABLE_STATES.join(", ")}`);
  }
  return value as Match["state"];
}

/** `risk: "read"` — called with `invokeTool` directly from the browser, which is the whole
 * reason this works from the board at all (a `write`/`destructive` tool 403s before `execute`).
 * Scoped by `profileId`, not by `limit` alone: RLS already confines every row to the actor's own,
 * but nothing stops one of the actor's OTHER profiles' matches from leaking into this profile's
 * board without this. Returns board records shaped from `Match` + `Posting`, never a raw store
 * row — the render-from-structured-records rule is only real if the shape returned here is
 * pinned by a test that names every key. */
export function createMatchesListHandler(store: JobSearchStore) {
  return async (ctx: ModuleWorkerContext): Promise<Record<string, unknown>> => {
    const input = stripEnvelope(ctx.input);
    for (const key of Object.keys(input)) {
      if (!MATCHES_LIST_KEYS.has(key)) {
        throw new InputError(`unknown key: ${key}`);
      }
    }
    const profileId = requireProfileId(input);
    const limit = requireLimit(input);
    const offset = readOffset(input);

    // One row past the page, purely to answer `hasMore` without a second COUNT query. The extra
    // row is never mapped or returned, so the render budget still only ever sees `limit` rows.
    const page = await store.listMatches(profileId, limit + 1, offset);
    const hasMore = page.length > limit;
    const matches = page.slice(0, limit);
    const postings = await store.getPostings(matches.map((match) => match.postingId));

    const items: BoardMatch[] = [];
    for (const match of matches) {
      const posting = postings.get(match.postingId);
      // A posting looked up by an id its own match still references but that has since been
      // removed is simply absent from the returned map (store-port.ts's own comment on
      // `getPostings`) — skipped here, the same "no posting, no item" rule
      // `domain/surface.ts`'s `matchItem` already applies to the briefing.
      if (posting === undefined) continue;
      const item: BoardMatch = {
        id: match.id,
        title: truncateText(posting.title, TITLE_MAX_CHARS),
        company: truncateText(posting.company, COMPANY_MAX_CHARS),
        fit: match.fit,
        want: match.want,
        outsideFrame: match.outsideFrame,
        state: match.state,
        url: truncateText(posting.url, URL_MAX_CHARS),
        location: truncateText(posting.location, LOCATION_MAX_CHARS),
        source: truncateText(labelFor(posting.sourceId), SOURCE_LABEL_MAX_CHARS),
        postedAt: posting.postedAt
      };
      const badFields = malformedBoardMatchFields(item);
      if (badFields.length > 0) {
        // #1336: field names only, never posting/job content (title, company, url, etc) — the
        // point of this log is diagnosing which field drifted, not a second copy of private data.
        console.error(
          `job-search matches.list: dropping match ${item.id} — invalid fields: ${badFields.join(", ")}`
        );
        continue;
      }
      items.push(item);
    }

    // `items.length` can be short of `limit` on a page that is NOT the last one: a match whose
    // posting has since been removed is skipped above. A caller walking the pages must therefore
    // advance by the `limit` it asked for and stop on `hasMore`, never infer the end from a short
    // page — see web/read-board.ts, which is the caller this contract exists for.
    return { items, hasMore };
  };
}

const MATCHES_COUNT_KEYS = new Set(["profileId"]);

/**
 * `risk: "read"` — how many rows the board holds, without reading them.
 *
 * The board's "is the search still finding things?" poll used to answer that by re-reading the
 * whole board every six seconds. That is seven requests a tick on a 167-row board, against a
 * host limit of sixty a minute shared by every module read tool in the app, so it earned 429s —
 * and a failed read part-way through a crawl is indistinguishable from a search that broke.
 * This is the same question at a fixed cost of one request at any board size.
 *
 * Nothing here is bounded by the 16 000-character render cap the list tool is shaped around:
 * the response is two integers, so this tool is also the one board read that cannot be truncated
 * out of existence.
 */
export function createMatchesCountHandler(store: JobSearchStore) {
  return async (ctx: ModuleWorkerContext): Promise<Record<string, unknown>> => {
    const input = stripEnvelope(ctx.input);
    for (const key of Object.keys(input)) {
      if (!MATCHES_COUNT_KEYS.has(key)) {
        throw new InputError(`unknown key: ${key}`);
      }
    }
    const profileId = requireProfileId(input);
    const counts = await store.countMatches(profileId);
    // `profileId` is echoed for the same reason match.get echoes `matchId`: the caller polls this
    // while the user may be switching profiles, and a response that does not say which board it
    // counted cannot be safely attributed to one.
    return { profileId, active: counts.active, scored: counts.scored };
  };
}

const MATCH_GET_KEYS = new Set(["matchId"]);
const DESCRIPTION_FAILURE_NAMESPACE = "description-fetch-failures";
const DESCRIPTION_RETRY_MS = 24 * 60 * 60 * 1_000;
const DESCRIPTION_FETCH_MAX_MS = 5_000;
const DESCRIPTION_DEADLINE_HEADROOM_MS = 1_000;
const LEGACY_LINKEDIN_BADGE_MAX_CHARS = 200;

async function beforeDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("description fetch timed out")), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** #1330: `risk: "read"`, one match by id, untruncated. Exists so the row can stay a capped
 * summary without the full Fit/Want reason becoming permanently unreachable — the inspector
 * calls this on open rather than the board ever fetching every match's full text up front, which
 * would just reproduce the render-cap problem `MATCHES_LIST_MAX_LIMIT` exists to avoid.
 *
 * Not-found (a wrong-owner id, a deleted match, or — #1329 — an unscored row's synthetic
 * posting-id "match id", which is never a real row) returns `{matchId, match: null}` rather than
 * throwing, matching `resume.get`'s own not-found idiom: the caller has one outcome to handle
 * either way, "nothing more to show here." */
export function createMatchGetHandler(store: JobSearchStore, fetch: FetchLike) {
  return async (ctx: ModuleWorkerContext): Promise<Record<string, unknown>> => {
    const input = stripEnvelope(ctx.input);
    for (const key of Object.keys(input)) {
      if (!MATCH_GET_KEYS.has(key)) {
        throw new InputError(`unknown key: ${key}`);
      }
    }
    const matchId = requireMatchId(input);

    const match = await store.getMatch(matchId);
    if (match === null) {
      return { matchId, match: null };
    }
    const posting = (await store.getPostings([match.postingId])).get(match.postingId);
    if (posting === undefined) {
      // Same "no posting, no item" rule as matches.list — a match whose posting has since been
      // removed has nothing left to show a title, company, or link for.
      return { matchId, match: null };
    }

    let body = capPostingBody(posting.body);
    // Older crawls stored LinkedIn's short benefits/applicant badge as `body`. Treat those rows
    // like an empty body once so opening an existing match repairs it as well as new postings.
    if (posting.sourceId === "linkedin" && body.length <= LEGACY_LINKEDIN_BADGE_MAX_CHARS) {
      body = "";
      const priorFailure = await ctx.kv
        .get("user", DESCRIPTION_FAILURE_NAMESPACE, posting.id)
        .catch(() => null);
      const failedAt =
        typeof priorFailure?.failedAt === "string" ? Date.parse(priorFailure.failedAt) : Number.NaN;
      const retrySuppressed =
        Number.isFinite(failedAt) && Date.now() - failedAt < DESCRIPTION_RETRY_MS;

      if (!retrySuppressed) {
        const timeoutMs = Math.min(
          DESCRIPTION_FETCH_MAX_MS,
          ctx.deadlineAt - Date.now() - DESCRIPTION_DEADLINE_HEADROOM_MS
        );
        try {
          if (timeoutMs <= 0) throw new Error("description fetch deadline exhausted");
          body = capPostingBody(
            await beforeDeadline(
              fetchLinkedInDescription(fetch, posting.externalId),
              Math.max(1, timeoutMs)
            )
          );
          // Public cache-fill exception inside this read tool: the write is idempotent, stays in
          // the actor's existing RLS scope, and only avoids fetching the same public detail again.
          await store
            .upsertPostings(match.profileId, [{ ...posting, body }])
            .catch(() => undefined);
        } catch {
          body = "";
          await ctx.kv
            .set("user", DESCRIPTION_FAILURE_NAMESPACE, posting.id, {
              failedAt: new Date().toISOString()
            })
            .catch(() => undefined);
        }
      }
    }

    const detail: MatchDetail = {
      id: match.id,
      title: posting.title,
      company: posting.company,
      url: posting.url,
      body,
      fit: match.fit,
      want: match.want,
      fitReason: match.fitReason,
      wantReason: match.wantReason,
      outsideFrame: match.outsideFrame,
      scoredAt: match.scoredAt,
      state: match.state
    };
    return { matchId, match: detail };
  };
}

/** One handler, two ways in, because the read and the write are forced onto different
 * transports (a `write` tool 403s with `confirmation_required` before `execute`, so a board
 * calling a write tool directly would silently do nothing):
 *
 * - The **board** enqueues the manual-run queue `job-search.match-state` with
 *   `{matchId, state}` — `ctx.input` is the four-field job envelope, `state` one level down in
 *   `params`, validated against `SETTABLE_STATES`.
 * - The **assistant** reaches this through the `job-search.match.dismiss` write tool, whose
 *   `inputSchema` declares `matchId` only — no `state` field exists on that tool at all, because
 *   the confirmation prompt in front of it is the consent boundary for "dismiss" specifically,
 *   not a generic state setter. That path always sets `state: "dismissed"`.
 *
 * Distinguishing the two is done on shape, not on a caller-supplied flag: a queue envelope always
 * has exactly `{actorUserId, jobKind, idempotencyKey, params}`; the tool shape never does. */
export function createMatchSetStateHandler(store: JobSearchStore) {
  return async (ctx: ModuleWorkerContext): Promise<Record<string, unknown>> => {
    const raw = ctx.input;
    let matchId: string;
    let state: Match["state"];

    if (looksLikeJobEnvelope(raw)) {
      const envelope = parseJobEnvelope(raw);
      matchId = requireMatchId(envelope.params);
      state = requireSettableState(envelope.params.state);
    } else {
      const input = stripEnvelope(raw);
      for (const key of Object.keys(input)) {
        if (key !== "matchId") {
          throw new InputError(`unknown key: ${key}`);
        }
      }
      matchId = requireMatchId(input);
      state = "dismissed";
    }

    await store.setMatchState(matchId, state);
    return {
      matchId,
      state,
      statusText:
        state === "dismissed" ? "Role passed" : state === "seen" ? "Role saved" : "Role new"
    };
  };
}

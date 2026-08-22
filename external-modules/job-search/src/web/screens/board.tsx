// external-modules/job-search/src/web/screens/board.tsx
// Task 20 (#1304): the match board. Every read after onboarding goes through
// job-search.matches.list (risk:read, so invokeTool works from the browser); every write 403s
// on that same route (packages/ai/src/routes.ts's confirmation_required gate on risk:write), so
// dismiss and "Search now" both go through runQueue's manual-run queues instead (Task 18's
// api.ts). runQueue resolves to "queued", not "done" — a dismiss is therefore optimistic: hide
// the row immediately, then reconcile against the next matches.list read, restoring the row
// with a plain message if it comes back still not-dismissed (the write never actually landed).
import { h, useCallback, useEffect, useRef, useState, type ReactNodeLike } from "../runtime";
import { invokeTool, runQueue } from "../api";
import { type FailureCause } from "../../domain/records.js";
import { readWholeBoard } from "../read-board";
import type { AssistantSurfaceHandleV1 } from "../../domain/seed-prompt.js";
import { Inspector } from "./inspector";
import { MatchRow } from "./match-row";
import { BoardFilterRow } from "./board-filters";
import { MatchRecordCard, useDiscuss } from "./discuss";
import { fetchResume } from "./resume-editor";
import {
  EMPTY_BOARD_FILTERS,
  filterBoardMatches,
  isScored,
  matchBucket,
  type BoardFilters,
  type BoardMatch,
  type MatchBucket,
  type MatchDetail,
  type PortalListItem
} from "../board-types";
import { useSearchRun, type SearchRunState } from "../use-search-run";

// #1333 (paging) is no longer deferrable and is done: this screen reads through
// web/read-board.ts, which walks `matches.list` a page at a time until the tool says there is
// nothing left. Passing the page size as the whole board was the reason a profile with 167 matches
// rendered 25 rows and every search afterwards left the count on the same number.

type MatchesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: BoardMatch[]; truncated: boolean; invalidCount: number };

type SortKey = "fit" | "want";
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

// #1330: a dedicated state machine for the async job-search.match.get fetch, kept separate from
// MatchesState because selecting a row must never perturb the list's own loading/ready/error
// state. Resets to idle whenever nothing is selected, so a later selection can never render a
// stale detail left over from the previous row.
type DetailState =
  | { status: "idle" }
  | { status: "loading"; matchId: string }
  | { status: "ready"; matchId: string; detail: MatchDetail }
  | { status: "error"; matchId: string; message: string };

export interface BoardScreenProps {
  profileId: string;
  // Task 20/#1304: absent on a v1.1 host or before root.tsx has one to hand down — Discuss simply
  // isn't offered in that case (useDiscuss's own no-op stance), same optionality as onboarding.tsx.
  assistantSurface?: AssistantSurfaceHandleV1;
  // Jump to the profile screen with the résumé editor already open. Optional so the board still
  // renders standalone in tests and in any caller that has nowhere to send the user.
  onAddResume?: () => void;
}

// Unscored rows sort last regardless of direction (the part file's explicit rule); scored rows
// compare only by the active key's own numeric value. Never blends fit and want into one
// comparator — sorting by one must never reorder by the other (L9's fit/want non-blending,
// extended to sort behavior, not just display).
/** How the board reads before the user has touched a column header.
 *
 * Not "whatever order the store returned". A board's whole claim is "here are the roles worth your
 * time", and unsorted it opened on an AI Model Engineer scoring 8 while five 88s sat below the
 * fold — which reads as a broken matcher rather than an unsorted table. Fit first because fit is
 * the axis the résumé evidence supports; want is the user's own preference and is never blended
 * into it (L9). Unscored rows sort last either way: they have no number to rank by, and burying
 * them keeps the top of the board answerable. */
const DEFAULT_SORT: SortState = { key: "fit", dir: "desc" };

/** Which default actually applies to THESE rows.
 *
 * Fit is the better default, but only where there is a Fit to sort by. With no résumé on file
 * every read row carries `fit: null`, and defaulting to a column of blanks leaves the board in
 * whatever order the store happened to return — the exact "reads as a broken matcher" the
 * default sort exists to prevent, now with a ▼ over an empty column claiming it is sorted. Want
 * is answerable without a résumé, so it takes over until a résumé makes Fit mean something. */
function defaultSortFor(items: BoardMatch[]): SortState {
  return items.some((item) => item.fit !== null) ? DEFAULT_SORT : { key: "want", dir: "desc" };
}

function sortMatches(items: BoardMatch[], sort: SortState | null): BoardMatch[] {
  const { key, dir } = sort ?? defaultSortFor(items);
  const scored = items.filter(isScored);
  const unscored = items.filter((item) => !isScored(item));
  scored.sort((a, b) => {
    const av = key === "fit" ? a.fit : a.want;
    const bv = key === "fit" ? b.fit : b.want;
    // A null on the active axis means "no basis to score", not "scored zero", so it sorts to the
    // bottom in BOTH directions — the same treatment an unread row gets. Subtracting it as if it
    // were 0 would make ascending order open on a block of blanks and rank them beneath a row
    // the model actually judged badly.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  });
  return [...scored, ...unscored];
}

/** Which direction the given column is sorted in right now, including the default nobody has
 *  clicked — a control that is sorted but shows no indicator invites the reader to distrust the
 *  order. Returns null when `key` isn't the active column, so the caller can skip the chevron
 *  entirely rather than render one pointing nowhere. */
function sortDirFor(
  sort: SortState | null,
  key: SortKey,
  items: BoardMatch[]
): SortState["dir"] | null {
  const effective = sort ?? defaultSortFor(items);
  return effective.key === key ? effective.dir : null;
}

// Mockup rewrite (task #99): the old indicator was " ▲"/" ▼" appended to the chip's own label —
// plain text standing in for a glyph. Sort has no mockup equivalent (`OPPS` in JobsMatches.jsx is
// pre-ordered, so the mockup never draws a sort control at all), but the board's own real sort is
// live functionality with nowhere else to go, so it stays — the ask was to stop forcing the old
// fit/want *rendering* into the mockup's shape, not to drop working controls the mockup simply
// never needed. What changes here is only the arrow: a real chevron element, same inline-stroke-SVG
// idiom match-row.tsx uses for its own chevron (finance's reports.tsx precedent), rotated for
// ascending rather than drawn as a second glyph.
function SortChevron(props: { dir: SortState["dir"] | null }): ReactNodeLike {
  if (props.dir === null) return null;
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={
        props.dir === "asc" ? "jsm-sort-chevron jsm-sort-chevron--asc" : "jsm-sort-chevron"
      }
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// lastOkAt is an ISO timestamp or null (never crawled to a success yet); this is deliberately a
// plain date, not a relative "3 days ago" phrase — the module has no ambient-clock allowance
// (check:no-ambient-dates) and a raw ISO slice needs none, unlike a relative-time computation.
function lastWorkedText(lastOkAt: string | null): string {
  return lastOkAt ? `Last worked ${lastOkAt.slice(0, 10)}.` : "Has never completed a search.";
}

// K2: bucket tabs partition the same ≤25-row set the sort controls already operate on — filtering
// is client-side, there is no second fetch per tab (matches.list has no notion of a "bucket";
// MatchState is the only state it tracks). "New" absorbs both `unscored` and `new`: the plan names
// only Saved (`seen`) and Passed (`dismissed`) explicitly, and the two remaining states share the
// one fact that actually matters here — nothing has happened to this match yet — so splitting them
// into a fourth tab would draw a distinction the board has no other use for.
const BUCKETS: ReadonlyArray<{ key: MatchBucket; label: string }> = [
  { key: "unreviewed", label: "Unreviewed" },
  { key: "saved", label: "Saved" },
  { key: "passed", label: "Passed" }
];

// Mockup rewrite (task #99): copy pulled verbatim from JobsMatches.jsx's own `EMPTY` table — this
// is authored UI text, not fabricated data, so reusing it is the same discipline as reusing the
// mockup's row/nav anatomy. The mockup's fourth bucket, `stale`, has no real counterpart (there is
// no staleness concept anywhere in the domain — see keyline.tsx's fitBand header for the same kind
// of "no product concept to check against" note) and is dropped along with it; `BUCKETS` above only
// ever has three keys.
const BUCKET_EMPTY: Record<MatchBucket, string> = {
  unreviewed: "Nothing credible has landed here yet. New matches appear after monitors run.",
  saved:
    "Ask your assistant to save an opportunity and it lands here — decisions happen in the conversation.",
  passed: "Roles you've passed on file here, with the reason kept."
};

// Renders a degraded or disabled portal's authored cause verbatim — never composed here.
// describeFailure (domain/records.ts) is the single authored voice for every failure sentence
// (Task 5's rule); N6 is why the board fetches this at all (nothing else can reach
// listPortals(profileId) from the browser). A self-disabled portal (login_required,
// cause.disabled === true) renders as calm disabled-with-cause, not an alert — otherwise a user
// would keep re-enabling a portal that can only ever fail the same way. cause.summary never
// mentions lastOkAt (records.ts's describeFailure has no reason to — a login-wall stops before
// retrieving anything), so "when it last worked" is rendered here, once, for every flagged
// portal regardless of failure kind.
function PortalBanner(props: { portals: PortalListItem[] }): ReactNodeLike {
  const flagged = props.portals.filter((portal) => portal.cause !== null);
  if (flagged.length === 0) return null;
  return (
    <div className="jsm-portal-banner">
      {flagged.map((portal) => {
        const cause = portal.cause as FailureCause;
        const disabled = !portal.enabled && cause.disabled;
        return (
          <p
            key={portal.sourceId}
            className="jds-card jds-card--sunken jsm-portal-banner__item"
            role={disabled ? "status" : "alert"}
          >
            <span className="jds-eyebrow">{portal.label}</span>{" "}
            {disabled ? <span className="jds-badge">Turned off</span> : null}
            <span>{cause.summary}</span> <span>{cause.nextAction}</span>{" "}
            <span className="jds-hint">{lastWorkedText(portal.lastOkAt)}</span>
          </p>
        );
      })}
    </div>
  );
}

// The notice's own copy, kept beside the states it describes rather than inline in the markup, so
// the whole vocabulary of this control is readable in one place. Every line is short on purpose:
// the control reserves a fixed column (.jsm-search-now) so the button cannot move when a notice
// appears, and a reserved column only works if nothing put in it wants to be a paragraph.
function runNotice(state: SearchRunState): { text: string; alert: boolean } | null {
  switch (state.status) {
    case "idle":
      return null;
    case "starting":
      return { text: "Starting…", alert: false };
    case "running":
      // No promise about scoring: the poll behind this state re-reads the board every few seconds,
      // so rows genuinely arrive under it, and saying less is safer than describing the mechanism.
      return { text: "Searching… new roles will appear below.", alert: false };
    case "finished":
      return {
        text:
          state.added === 0
            ? "Search finished — nothing new this time."
            : `Search finished — ${state.added} new ${state.added === 1 ? "role" : "roles"}.`,
        alert: false
      };
    case "still-running":
      // Six minutes elapsed without the board settling. The run may well still be working, so this
      // says what is true rather than declaring a failure or a success.
      return { text: "Still working — the board keeps updating.", alert: false };
    case "disabled":
      return { text: "Manual search is turned off for this account.", alert: false };
    case "error":
      return { text: `Couldn't start a search: ${state.message}`, alert: true };
  }
}

function SearchNowControl(props: {
  profileId: string;
  refreshBoard: () => Promise<void>;
}): ReactNodeLike {
  // Deliberately does not check ../latch.ts's isLatched: that latch exists only to stop the
  // *automatic* per-profile crawl on mount from firing twice (root.tsx's own effect).
  // "Search now" is a deliberate, explicit user action and must enqueue every time it's clicked,
  // latched or not.
  const { state, start } = useSearchRun(props.profileId, props.refreshBoard);
  // Disabled for the whole run, not just for the enqueue request. The POST answers in about a
  // hundred milliseconds and the run it started takes minutes; re-enabling on the POST meant the
  // button spent the entire search looking ready, and a second click only hit the host's
  // five-second singleton and then enqueued a duplicate crawl.
  const busy = state.status === "starting" || state.status === "running";
  const notice = runNotice(state);

  return (
    <div className="jsm-search-now">
      {/* Secondary, not primary. The board itself is what the user came for; searching again is a
          refresh. A filled accent button here made the one repeatable maintenance action the
          loudest thing on a page of twenty results. */}
      <button
        type="button"
        className="jds-btn jds-btn--secondary"
        onClick={start}
        disabled={busy}
        aria-busy={busy}
      >
        {/* The label never changes. Swapping it to "Searching…" while a run is in flight would
            resize the button, which is the same complaint as the notice pushing it sideways — the
            control has to hold still. Disabled state plus the notice beneath it carry the status. */}
        Search now
      </button>
      {notice ? (
        <p className="jsm-queue-notice" role={notice.alert ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

export function BoardScreen(props: BoardScreenProps): ReactNodeLike {
  const { profileId } = props;
  const [matchesState, setMatchesState] = useState<MatchesState>({ status: "loading" });
  const [portals, setPortals] = useState<PortalListItem[]>([]);
  const [sort, setSort] = useState<SortState | null>(null);
  const [bucket, setBucket] = useState<MatchBucket>("unreviewed");
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_BOARD_FILTERS);
  const filterNowRef = useRef(Date.now());
  const returnTargetRef = useRef<{
    scrollY: number;
    matchId: string;
    fallbackId: string | null;
  } | null>(null);
  const pendingStatesRef = useRef(new Map<string, "seen" | "dismissed">());
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  // A read that failed while the board already had rows. Kept apart from MatchesState because the
  // two mean different things: this one is "the rows on screen are a moment stale", not "there is
  // nothing to show". See fetchMatches's catch for why the difference matters.
  const [readError, setReadError] = useState<string | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle" });
  // null until the résumé read below lands (or if it fails) — see that effect.
  const [hasResume, setHasResume] = useState<boolean | null>(null);
  const { discussing, discuss, close: closeDiscuss } = useDiscuss(props.assistantSurface);

  // The conversation renders full width under the board, which is the right measure for a
  // transcript — but on a twenty-row board that put it about a thousand pixels below the Discuss
  // button, so clicking Discuss appeared to do nothing at all. Same treatment as the inspector's
  // own panel; optional-chained because the unit renderer hands back no real node.
  const discussRef = useRef<{ scrollIntoView?: (opts: unknown) => void } | null>(null);
  useEffect(() => {
    if (discussing === null) return;
    discussRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [discussing]);

  // Queue acceptance is not completion. Preserve the user's optimistic decision across reads
  // until a read confirms the worker applied it; otherwise an immediate stale read makes a role
  // disappear and then come back. An enqueue rejection is handled separately below.
  const reconcilePendingStates = useCallback((freshItems: BoardMatch[]): BoardMatch[] => {
    if (pendingStatesRef.current.size === 0) return freshItems;
    return freshItems.map((item) => {
      const pending = pendingStatesRef.current.get(item.id);
      if (pending === undefined) return item;
      if (item.state === pending) {
        pendingStatesRef.current.delete(item.id);
        return item;
      }
      return { ...item, state: pending };
    });
  }, []);

  // Returns a digest of what landed, or null if the read failed, so a caller following a run can
  // tell "still arriving" from "settled" without owning the board's state. Dismissed rows are
  // excluded because a run's own count must not move when the user passes on something. It does
  // Pending decisions are overlaid by reconcilePendingStates, so this read stays server-shaped.
  // Whether a read has ever succeeded, in a ref rather than derived from matchesState: naming that
  // state in this callback's dependency list would rebuild the callback on every read and restart
  // any poll holding a reference to it.
  const hasRowsRef = useRef(false);

  // Returns nothing on purpose. It used to hand back a digest so the search poll could tell a
  // changing board from a settled one, which meant every tick of a run re-read all seven pages —
  // and every module read tool in the app shares one sixty-per-minute host budget, so that poll
  // spent about eighty and collected 429s. The poll now asks `job-search.matches.count` for that
  // number in a single request and calls this only when it has changed.
  const readWholeBoardIntoState = useCallback(async (): Promise<void> => {
    try {
      // Every page, not the first one — see web/read-board.ts for why the board is paged at all
      // and why 25 is a page size rather than the size of the board.
      const { items, truncated, invalidCount } = await readWholeBoard(profileId);
      setMatchesState({
        status: "ready",
        items: reconcilePendingStates(items),
        truncated,
        invalidCount,
      });
      hasRowsRef.current = true;
      setReadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't load your matches.";
      // A board that already has rows is never thrown away because one read failed. The search
      // control lives inside this screen, so replacing the whole board with an error card also
      // unmounts the run that is still going — measured live: a single failed read partway into a
      // crawl took the rows, the button and the run with it, and the user saw a board that had
      // simply stopped existing. Keep the rows, say plainly that they may be a moment stale, and
      // let the next read recover. Only a board with nothing on it yet shows the error card.
      if (hasRowsRef.current) {
        setReadError(message);
        return;
      }
      setMatchesState({ status: "error", message });
    }
  }, [profileId, reconcilePendingStates]);

  // A full read is one request per 25 rows — seven on a 168-row board — and every module read tool
  // in the app shares one sixty-per-minute host budget. Two of them overlapping is therefore not a
  // harmless duplicate but fourteen requests inside a second: measured live, the window-focus
  // refetch landing on top of the mount read doubled every page offset and collected 429s, and a
  // 429 mid-read loses a whole page of the board. So a caller that only wants current rows joins
  // the read already in flight (refreshRows below), while a caller that must see a write it just
  // made always starts its own (fetchMatches) — a dismissal served a read that began before its
  // own write would look like the write never landed and raise a false "didn't go through".
  const inFlightRef = useRef<Promise<void> | null>(null);

  const fetchMatches = useCallback((): Promise<void> => {
    const run = readWholeBoardIntoState().finally(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
    inFlightRef.current = run;
    return run;
  }, [readWholeBoardIntoState]);

  const refreshRows = useCallback(
    (): Promise<void> => inFlightRef.current ?? fetchMatches(),
    [fetchMatches]
  );

  // Joins rather than forces, same as the focus refetch: a mount has no write of its own to
  // confirm, and under React's development double-mount this effect runs twice, which is where the
  // board's every page offset being requested twice came from — fourteen requests against a
  // sixty-per-minute budget before the user had done anything.
  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  // Portal health is a banner, not a blocking read — a failed fetch just means no banner this
  // render; the board still works from matches.list alone.
  useEffect(() => {
    invokeTool("job-search.portal.list", { profileId })
      .then((result) => {
        const list = (result as { portals?: PortalListItem[] } | null)?.portals;
        setPortals(Array.isArray(list) ? list : []);
      })
      .catch(() => undefined);
  }, [profileId]);

  // Whether a résumé exists, read directly rather than inferred from the rows. The board used to
  // decide this from "every scored row has an empty Fit", which is a good tell but only once
  // there are scored rows — a board that hasn't finished its first crawl showed nothing at all,
  // which is exactly the state Ben was in when he asked for this notice to live here. Same
  // non-blocking stance as portals: `null` means "don't know yet", and the row heuristic below
  // still covers that case, so a failed read degrades to the old behaviour instead of hiding the
  // notice.
  useEffect(() => {
    let cancelled = false;
    fetchResume(profileId)
      .then((resume) => {
        if (!cancelled) setHasResume(resume !== null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // No reload key: the view switcher swaps BoardScreen out entirely for the profile screen, so
    // coming back from adding a résumé remounts this and re-reads on its own.
  }, [profileId]);

  // Refetch on window focus — guarded so this is a no-op under the plain-node test environment
  // (see latch.ts's own try/catch precedent for "no window" as an expected, not exceptional,
  // runtime).
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    // Joins a read already in flight rather than starting a second one — see inFlightRef above.
    // A focus event carries no information about a write, so current rows are all this wants.
    const handler = (): void => {
      void refreshRows();
    };
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [refreshRows]);

  // #1330: fetches the untruncated detail (fitReason/wantReason, per N39) the instant a row is
  // selected — Inspector never calls invokeTool itself (see that file's header). `cancelled`
  // guards the same kind of race the pending-state tracking guards above: if the
  // selection changes again before this resolves, the stale response must never overwrite the
  // newer selection's state. An unscored match's id never resolves to a real row (#1329), so
  // match.get correctly answers `null` for it — surfaced here as an error state that Inspector
  // simply never reads, since it only renders fit/want reasons for scored matches.
  useEffect(() => {
    if (selectedMatchId === null) {
      setDetailState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const matchId = selectedMatchId;
    setDetailState({ status: "loading", matchId });
    invokeTool("job-search.match.get", { matchId })
      .then((result) => {
        if (cancelled) return;
        const detail = (result as { match?: MatchDetail | null } | null)?.match ?? null;
        if (detail === null) {
          setDetailState({
            status: "error",
            matchId,
            message: "Couldn't load the full detail for this match."
          });
          return;
        }
        setDetailState({ status: "ready", matchId, detail });
      })
      .catch((error) => {
        if (cancelled) return;
        setDetailState({
          status: "error",
          matchId,
          message:
            error instanceof Error ? error.message : "Couldn't load the full detail for this match."
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMatchId]);

  function queueMatchState(matchId: string, state: "seen" | "dismissed"): void {
    setRestoreMessage(null);
    pendingStatesRef.current.set(matchId, state);
    setMatchesState((current) =>
      current.status === "ready"
        ? {
            ...current,
            items: current.items.map((item) => (item.id === matchId ? { ...item, state } : item))
          }
        : current
    );
    runQueue("job-search.match-state", "match.set-state", { matchId, state })
      .then((outcome) => {
        if (outcome.kind !== "disabled" && outcome.kind !== "error") return;
        pendingStatesRef.current.delete(matchId);
        setRestoreMessage(
          state === "dismissed"
            ? "That role couldn't be passed. It is back on your board."
            : "That role couldn't be saved."
        );
        void fetchMatches();
      })
      .catch(() => {
        pendingStatesRef.current.delete(matchId);
        setRestoreMessage(
          state === "dismissed"
            ? "That role couldn't be passed. It is back on your board."
            : "That role couldn't be saved."
        );
        void fetchMatches();
      });
  }

  function handleDismiss(matchId: string): void {
    if (selectedMatchId === matchId) closeInspector(true);
    queueMatchState(matchId, "dismissed");
  }

  // #100: the board's other settable state (worker/handlers/matches.ts's SETTABLE_STATES already
  // allows "seen" through this same queue path) — mirrors handleDismiss's shape (close the detail
  // view immediately, then queue the same optimistic state transition. Closing the view on both
  // actions sidesteps a real
  // race — `selectedMatch` below is derived from the current bucket's own filtered+sorted list, so
  // a Save/Pass that moves an item to a different bucket can make it vanish from that list the
  // moment fetchMatches resolves; closing immediately means Inspector never renders against that
  // mid-transition state.
  function handleSave(matchId: string): void {
    if (selectedMatchId === matchId) closeInspector(true);
    queueMatchState(matchId, "seen");
  }

  function closeInspector(useFallback = false): void {
    const target = returnTargetRef.current;
    returnTargetRef.current = null;
    setSelectedMatchId(null);
    if (!target || typeof window === "undefined" || typeof document === "undefined") return;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: target.scrollY });
      const focusId = useFallback ? target.fallbackId : target.matchId;
      const focusTarget =
        (focusId ? document.getElementById(`job-search-match-${focusId}`) : null) ??
        document.getElementById("job-search-board-heading");
      focusTarget?.focus();
    });
  }

  function openInspector(matchId: string, fallbackId: string | null): void {
    returnTargetRef.current = {
      scrollY: typeof window === "undefined" ? 0 : window.scrollY,
      matchId,
      fallbackId
    };
    setSelectedMatchId(matchId);
  }

  function toggleSort(key: SortKey): void {
    // `prev ?? the effective default`, because the board arrives already sorted. Treating an
    // untouched board as "no sort" meant the first click on the column it was already sorted by
    // re-applied the order that was on screen already, and the header did nothing. Read the
    // default off the rows for the same reason `sortIndicator` does: which column the board
    // opened on depends on whether Fit has anything in it.
    const items = matchesState.status === "ready" ? matchesState.items : [];
    setSort((prev) => {
      const current = prev ?? defaultSortFor(items);
      if (current.key !== key) return { key, dir: "desc" };
      return { key, dir: current.dir === "desc" ? "asc" : "desc" };
    });
  }

  if (matchesState.status === "loading") {
    return (
      <div className="jds-card jds-card--sunken jsm-state" role="status">
        <span className="jds-eyebrow">Job search</span>
        <p>Loading your matches…</p>
      </div>
    );
  }

  if (matchesState.status === "error") {
    return (
      <div className="jds-card jds-card--sunken jsm-state" role="alert">
        <span className="jds-eyebrow">Job search</span>
        <p>Couldn't load your matches: {matchesState.message}</p>
        <button
          type="button"
          className="jds-btn jds-btn--secondary"
          onClick={() => void fetchMatches()}
        >
          Try again
        </button>
      </div>
    );
  }

  // activeItems mirrors the board's pre-bucket semantics exactly — dismissed rows excluded —
  // because the hero's role count and "X read and scored"
  // line describe the whole board, not whichever bucket happens to be open. Switching tabs must
  // never move that figure.
  const activeItems = matchesState.items.filter((item) => item.state !== "dismissed");
  const scoredCount = activeItems.filter(isScored).length;
  // No résumé means every Fit on this board is empty and stays empty, because a résumé is the
  // only thing Fit is judged against. A column of em dashes with no explanation reads as a
  // product that is broken rather than one waiting on something, and the fix is a thing only the
  // user can do — so it has to be said, and said with the action in it.
  //
  // Preferred source is the direct résumé read above; the row heuristic is the fallback for the
  // frame before it lands and for a read that failed. The heuristic alone was the whole test
  // until 2026-07-29, and it silently said nothing on a board with no scored rows yet — a state
  // a brand-new profile sits in for its entire first crawl.
  const fitNeedsResume =
    hasResume === null
      ? scoredCount > 0 && activeItems.filter(isScored).every((item) => item.fit === null)
      : !hasResume;

  // boardItems is activeItems' opposite number: every row INCLUDING dismissed ones, so Passed has
  // something to show.
  const boardItems = matchesState.items;
  const filteredItems = filterBoardMatches(boardItems, filters, filterNowRef.current);
  const bucketCounts: Record<MatchBucket, number> = { unreviewed: 0, saved: 0, passed: 0 };
  for (const item of filteredItems) bucketCounts[matchBucket(item)] += 1;
  const bucketItems = filteredItems.filter((item) => matchBucket(item) === bucket);
  const sorted = sortMatches(bucketItems, sort);
  const selectedMatch = sorted.find((item) => item.id === selectedMatchId) ?? null;

  // Guarded by matchId, not just detailState.status: effects run after render, so there is one
  // render frame where selectedMatchId has already changed but the fetch effect above hasn't
  // fired yet. Without this check, that frame would briefly show the previous row's detail (or
  // error) under the new row's heading.
  const detail =
    detailState.status === "ready" && detailState.matchId === selectedMatchId
      ? detailState.detail
      : null;
  const detailError =
    detailState.status === "error" && detailState.matchId === selectedMatchId
      ? detailState.message
      : null;

  // Discuss needs the full MatchDetail (fitReason/wantReason, per L9) the card and controlContext
  // both depend on, not just the row's BoardMatch — so, like Open posting and Dismiss, it's only
  // offered from the inspector, once a row's detail has loaded, never a bare-row action. Absent
  // assistantSurface, this stays null and Inspector renders no Discuss control at all (discuss.tsx
  // header: "an action that silently does nothing is worse than an action that is not there").
  const onDiscuss = props.assistantSurface && detail ? () => discuss(detail) : null;

  // Surface is the host's real chat view (see onboarding.tsx's identical h(Surface, ...) call) —
  // this module never builds a second chat implementation. Guarded on `discussing === detail.id`,
  // not just `discussing !== null`: selecting a different row nulls `detail` for a render or more
  // before its own fetch resolves, and the guard here (paralleling the detail/detailError guards
  // above) stops that gap from flashing the previous match's card under the new row.
  const Surface = props.assistantSurface?.Surface;
  const discussPanel =
    discussing !== null && detail !== null && discussing === detail.id && Surface ? (
      <div ref={discussRef} className="jds-card jds-card--sunken jsm-discuss-panel">
        {/* A title bar, not two controls jammed together: the eyebrow said "Discussing" and stopped,
            so the only thing naming the role under discussion was the record card further down. */}
        <div className="jsm-discuss-panel__head">
          <span className="jds-eyebrow">Discussing {detail.title}</span>
          <button
            type="button"
            className="jds-btn jds-btn--quiet jds-btn--sm"
            onClick={closeDiscuss}
          >
            Close
          </button>
        </div>
        {
          // localRows are client-only (never enter the transcript, per LocalRow's own contract) —
          // the model's copy of this same record travels separately, in discuss()'s submitTurn
          // controlContext, not through this prop.
          h(Surface, {
            localRows: [
              {
                id: `discuss-${detail.id}`,
                role: "assistant",
                content: <MatchRecordCard detail={detail} />
              }
            ],
            composer: {}
          })
        }
      </div>
    ) : null;

  return (
    <div className="jsm-board-screen">
      <PortalBanner portals={portals} />
      {/* The board's own header row. "Search now" used to sit alone under the view tabs as a third
          stacked row of buttons, with nothing anywhere saying what was on the board or how much of
          it had been read — and "read" matters here, because scoring is budgeted and a run can
          leave most of a crawl unscored. The count says that plainly; the action sits beside it
          rather than above it. */}
      <header className="jsm-hero">
        <div className="jsm-hero__lede">
          <span className="jds-eyebrow">On your board</span>
          {/* The count at display scale, because it is the answer to the only question anyone
              opens this screen with. As a line of prose ("14 roles · 9 scored so far") it had to
              be read before it could be understood, and it sat at body weight beside a button,
              which made the button the loudest thing on a page about opportunities. */}
          <p id="job-search-board-heading" className="jsm-hero__figure" tabIndex={-1}>
            <span className="jds-hero-figure">{activeItems.length}</span>
            <span className="jds-eyebrow">{activeItems.length === 1 ? "role" : "roles"}</span>
          </p>
          {/* The scoring caveat appears ONLY when some of the board is genuinely unread. It used to
              have an else-branch — "Every posting here has been read and scored." — which is the
              normal state, so the line was on screen almost always and said nothing: it read as
              marketing copy under a figure it was supposed to qualify. A caveat that never fires is
              not a caveat. Silence now means what it should: everything here has been read.
              No date anywhere — the module has no ambient-clock allowance
              (check:no-ambient-dates), which is why the mockup's "Wednesday · July 15" dateline is
              not reproduced. */}
          {/* The strap stays unconditionally: it is the mockup's accent bar under the figure, one of
              the few places the board carries colour at all, and it marks the end of the lede
              whether or not there is a caveat to print after it. */}
          <span className="jds-strap" aria-hidden="true" />
          {scoredCount < activeItems.length ? (
            <p className="jsm-hero__prose">
              {scoredCount} read and scored so far — the rest are queued.
            </p>
          ) : null}
        </div>
        <SearchNowControl profileId={profileId} refreshBoard={refreshRows} />
      </header>
      <hr className="jds-divider jds-divider--strong jsm-hero__rule" />
      {restoreMessage ? (
        <p className="jsm-queue-notice" role="status">
          {restoreMessage}
        </p>
      ) : null}
      {/* Stale, not broken: the rows below are the last ones that loaded. Deliberately a small
          notice rather than the error card, because the board and any search in progress are both
          still here. */}
      {readError ? (
        <p className="jsm-queue-notice" role="status">
          Couldn&rsquo;t refresh just now ({readError}) — these rows are from the last load.
        </p>
      ) : null}
      {/* A bounded surface, not a bare paragraph. This is the one persistent advisory on the
          screen — every Fit column on the board is empty until it is acted on — and as loose text
          directly above the table it read as a caption the eye skips on the way to the rows. The
          eyebrow gives it a name so it is identifiable as a thing to deal with rather than a
          sentence of chrome. */}
      {fitNeedsResume ? (
        <div className="jds-card jds-card--sunken jds-card--pad-sm jsm-notice" role="status">
          {/* An amber badge rather than a bare eyebrow. The notice was a grey label on a grey
              sunken card between two other grey blocks, so the one thing on the board that is
              actually actionable — Fit stays empty until you do something — looked like chrome.
              Amber is the caution tone the badge scale already provides; the copy is unchanged and
              still explains rather than alarms. */}
          <span className="jds-badge jds-badge--amber">No résumé on file</span>
          <p className="jsm-notice__body">
            Fit is empty because there&rsquo;s no résumé on file — it&rsquo;s the only thing Fit is
            judged against. Add one and every role here gets read again with it.
          </p>
          {/* The notice used to end at "paste yours into the chat", which was the only route that
              existed when it was written and stopped being true once the upload UI shipped. Ben:
              "we need to keep that disclaimer on the board if the user doesn't have a resume and
              give them an option to upload there." The upload itself stays on the profile screen —
              one editor, one state machine — so this is a jump to it, not a second copy of it. */}
          {props.onAddResume ? (
            <button
              type="button"
              className="jds-btn jds-btn--secondary jds-btn--sm"
              onClick={props.onAddResume}
            >
              Add résumé
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Mockup rewrite (task #99): the list and the open match used to be one two-column region,
          the table beside a side panel (the retired `.jsm-board-body`/`--open` split, removed in
          #102's CSS cleanup). JobsMatches.jsx never does that — its own top-level
          component is `if (openId) return <DetailView/>; return <ListView/>`, a full swap, not a
          drawer (the README's own "the detail view replaces the list — it is not a drawer" rule).
          selectedMatch is the same signal the split used to key off of; it now picks which branch
          renders instead of which grid-template applies. PortalBanner and the dismiss-reconciliation
          notice above stay visible either way — they're board-level status, not part of either
          view. */}
      {selectedMatch ? (
        <div className="jsm-board-detail">
          <Inspector
            match={selectedMatch}
            detail={detail}
            detailError={detailError}
            onClose={() => closeInspector()}
            onDismiss={(matchId) => handleDismiss(matchId)}
            onSave={(matchId) => handleSave(matchId)}
            onDiscuss={onDiscuss}
          />
          {discussPanel}
        </div>
      ) : boardItems.length === 0 ? (
        <div className="jds-card jds-card--sunken jsm-state" role="status">
          <span className="jds-eyebrow">Job search</span>
          <p>No matches yet — check back once your next search run finishes.</p>
        </div>
      ) : (
        <div className="jsm-board-list">
          {/* BUCKETS — gold marker, same idiom as the module's own view tabs (JobsMatches.jsx's own
              comment on this nav, and the reason `jds-tab--gold` exists at all per
              components-moss.css's header: "Job Search's bucket nav"). This used to be
              `jds-chip--toggle` filter chips out of a since-reversed worry that reusing `jds-tabs`
              here would read as two identical tab strips meaning two different things — but the
              mockup deliberately wants that visual echo (its own bucket nav sits directly under the
              module's Matches/Overview/Profile/Monitors switcher and uses the same gold-underline
              idiom on purpose), so this now matches it instead of working around it.

              Filtering stays entirely client-side over `boardItems`, the ≤25-row page matches.list
              already returned; pressing a bucket never re-fetches. */}
          <nav className="jds-tabs" aria-label="Match bucket">
            {BUCKETS.map((b) => (
              <button
                key={b.key}
                type="button"
                aria-current={bucket === b.key ? "page" : undefined}
                className="jds-tab jds-tab--gold"
                onClick={() => setBucket(b.key)}
              >
                {b.label}
                <span className="jds-tab__count">{bucketCounts[b.key]}</span>
              </button>
            ))}
          </nav>

          <BoardFilterRow
            filters={filters}
            sources={[...new Set(boardItems.map((item) => item.source))].sort()}
            onChange={setFilters}
          />
          {matchesState.truncated ? (
            <p className="jsm-queue-notice" role="status">
              Filters and counts apply to the first 1,000 loaded roles.
            </p>
          ) : null}
          {matchesState.invalidCount > 0 ? (
            <p className="jsm-queue-notice" role="status">
              {matchesState.invalidCount === 1
                ? "1 role couldn't be shown"
                : `${matchesState.invalidCount} roles couldn't be shown`}{" "}
              — the server sent something the board didn't recognize.
            </p>
          ) : null}

          {bucketItems.length > 0 ? (
            /* Sorting has no mockup equivalent (JobsMatches.jsx's OPPS is pre-ordered) but is real,
               working functionality with nowhere else to go — kept as its own small control rather
               than dropped, and hidden entirely once a bucket has nothing to sort. */
            <div className="jsm-sort-row" role="group" aria-label="Sort">
              <span className="jds-eyebrow jds-eyebrow--muted">Sort</span>
              <button
                type="button"
                className="jds-chip jds-chip--toggle"
                aria-pressed={sort?.key === "fit"}
                onClick={() => toggleSort("fit")}
              >
                Fit <SortChevron dir={sortDirFor(sort, "fit", bucketItems)} />
              </button>
              <button
                type="button"
                className="jds-chip jds-chip--toggle"
                aria-pressed={sort?.key === "want"}
                onClick={() => toggleSort("want")}
              >
                Want <SortChevron dir={sortDirFor(sort, "want", bucketItems)} />
              </button>
            </div>
          ) : null}

          {sorted.length === 0 ? (
            // A bucket can be legitimately empty (nothing Saved yet) while the board as a whole is
            // not — scoped to the open tab, not the "No matches yet" empty-board state above, which
            // only fires when boardItems itself is empty. `jds-divider` opens it the same way the
            // mockup's own borderTop does (a module can't draw a hairline itself — see keyline.tsx's
            // header); copy is EMPTY[bucket] verbatim, minus the `stale` entry this board has no
            // bucket for.
            <div className="jsm-bucket-empty">
              <hr className="jds-divider" />
              <span className="jds-eyebrow">Nothing here yet</span>
              <p className="jsm-bucket-empty__body">{BUCKET_EMPTY[bucket]}</p>
            </div>
          ) : (
            <div className="jsm-list">
              {/* No `divided`/`i > 0` bookkeeping any more — `MatchRow` draws its own top hairline
                  on every row via `jds-hairline-row` unconditionally (matching the mockup, which
                  doesn't special-case its first row either). The trailing divider below closes the
                  list off at the bottom, the mockup's own borderBottom on the row container. */}
              {sorted.map((item, index) => (
                <MatchRow
                  key={item.id}
                  item={item}
                  onOpen={(matchId) =>
                    openInspector(matchId, sorted[index + 1]?.id ?? sorted[index - 1]?.id ?? null)
                  }
                  onSave={handleSave}
                  onPass={handleDismiss}
                />
              ))}
              <hr className="jds-divider" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

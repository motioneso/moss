// external-modules/job-search/src/web/screens/settings.tsx
// Task 20 (#1304, settings half); trimmed by K4, redesigned by K7 (2026-07-28 keyline-restructure
// plan — Monitors tab). K4 moved résumé and briefing-detail off this screen to profile.tsx,
// leaving exactly one job: which job boards this search watches, and what state each one is in.
// K5/K8 already wired the tab itself (root.tsx routes "Monitors" here unchanged) — this task only
// redraws what SettingsScreen renders, following a Claude Design mockup (JobsMonitors.jsx) the
// coordinator described by hand because the file itself couldn't be read directly.
//
// The mockup draws a four-fact grid (Schedule / Last checked / Last success / Found today) and two
// header buttons ("Add a monitor", "Edit query") that this screen deliberately does NOT build.
// Every one of those was checked against the real wire shape and the real manifest before writing
// any markup here, not assumed from the mockup's own copy:
//   - job-search.portal.list (worker/handlers/portal.ts createPortalListHandler) returns exactly
//     {sourceId, label, enabled, lastOkAt, cause} per portal. There is no schedule field, no
//     "last checked" distinct from the last successful run, and no "found today" count anywhere on
//     the wire — so the fact grid below renders the one fact that's real ("Last success") and
//     nothing else. Two honest facts beat four where two are fiction.
//   - job-search.source.add / job-search.source.remove (worker/handlers/source.ts) exist as
//     assistantTools with risk:"write" but have NO worker.queues entry — a write-risk tool reached
//     through invokeTool 403s with confirmation_required before it runs (rulings I3/I4), and there
//     is no runQueue path either, because no queue is declared. "Add a monitor" and "Edit query"
//     would be buttons wired to nothing, so neither is built; the footer line below points to chat
//     instead, which is the one way either action genuinely works today.
//   - job-search.crawl-run (worker.queues, allowManualRun: true, paramsSchema {profileId}) is real
//     and reachable — but it crawls every enabled board for the profile, not one board at a time.
//     "Run now" below is honest about that scope rather than implying a per-board rerun the queue
//     can't actually do.
//
// Reads and writes take different transports, and the split is forced (rulings I3/I4): reading
// job-search.portal.list is risk:"read" so it goes straight through invokeTool from the browser.
// job-search.portal.set-enabled is risk:"write" — invokeTool on a write tool 403s with
// confirmation_required before the tool ever runs (packages/ai/src/routes.ts:645-668) — so it
// goes through the manual-run queue (runQueue) instead. runQueue only ever reports "queued" or
// "already-queued", never "done" (I5), so both writes below (the enable/pause switch and Run now)
// apply optimistically/settle-to-"queued" and are reconciled by re-fetching job-search.portal.list,
// never assumed to have completed.
import { Fragment, h, useCallback, useEffect, useState, type ReactNodeLike } from "../runtime";
import { invokeTool, runQueue, type RunOutcome } from "../api";
import { FieldPair, KeyRow, SectionHead, formatPostedOn } from "../keyline";
import type { Profile } from "../use-profiles";

// Queue name follows root.tsx's existing job-search.crawl-run / crawl.run precedent: queue name
// dashes the tool's last two path segments, jobKind keeps the tool's own dotted handler name.
// Exported (along with PORTAL_LIST_TOOL below) so
// tests/unit/job-search-manifest-conformance.test.tsx can assert these exact literals — not a
// retyped copy — are declared in the committed manifest with the right shape (worker.queues
// entry + allowManualRun for the queue, assistantTools entry + risk:"read" for the tool).
// PROFILE_SET_BRIEFING_DETAIL_QUEUE moved to profile.tsx along with the control that calls it —
// the conformance test now imports that literal from there.
export const PORTAL_SET_ENABLED_QUEUE = "job-search.portal-set-enabled";

// The one tool this screen ever passes to invokeTool. Reads only — a write-risk tool reached
// through invokeTool 403s with confirmation_required before it runs (rulings I3/I4), so this
// being declared risk:"read" in the manifest is load-bearing, not decorative.
export const PORTAL_LIST_TOOL = "job-search.portal.list";

// Wire shape of job-search.portal.list's result (worker/handlers/portal.ts
// createPortalListHandler) — defined fresh here rather than imported from the domain layer,
// the same wire-shape-not-domain-shape split use-profiles.ts's header documents for
// job-search.profile.list. cause is read as FailureCause.summary/nextAction/disabled; this
// screen never composes its own sentence for why a portal is off (constraint: a self-disabled
// portal reads as disabled-with-a-reason, not as an error or a user choice).
//
// PortalCause below is deliberately narrower than what's actually on the wire: the handler
// forwards the full 9-field domain FailureCause unmodified (portal.ts's `cause: portal.cause`),
// but this screen only ever reads these 3 fields, so only these 3 are declared — same
// wire-type-not-domain-type reasoning as above, applied a second time to say "this is all we
// use" rather than "this is all there is."
interface PortalCause {
  summary: string;
  nextAction: string;
  disabled: boolean;
}

interface PortalRow {
  sourceId: string;
  label: string;
  enabled: boolean;
  lastOkAt: string | null;
  cause: PortalCause | null;
}

type PortalsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; rows: PortalRow[] };

async function fetchPortals(profileId: string): Promise<PortalRow[]> {
  const result = (await invokeTool(PORTAL_LIST_TOOL, { profileId })) as {
    portals?: PortalRow[];
  };
  return Array.isArray(result?.portals) ? result.portals : [];
}

// The queue "Run now" drives. Not exported: unlike PORTAL_SET_ENABLED_QUEUE/PORTAL_LIST_TOOL, no
// test needs to import this literal by reference — the manifest-conformance blind sweep (its own
// header explains why) finds it by grepping the literal itself, and this screen's own test drives
// the control and asserts the runQueue call shape directly. Same queue, same job kind, board.tsx's
// SearchNowControl already uses on the board screen — see this file's header for why a per-row
// button is still honest even though the queue itself has no per-portal scope.
const CRAWL_RUN_QUEUE = "job-search.crawl-run";

/** One status dot colour per real state on the wire — never a fifth state invented to fill a gap.
 *  crawl.ts's own failure handling (worker/stages/crawl.ts) is what makes all four of these
 *  reachable: only a `login_required` failure sets `cause.disabled`/turns the portal off on its
 *  own; every other failure kind (rate_limited, parse_failed, network, deadline) leaves the portal
 *  `enabled: true` with a cause attached, so "on but struggling" is a real, distinct state from
 *  either "on and fine" or "off". */
function statusModifier(row: PortalRow): "ready" | "drift" | "idle" {
  if (!row.enabled) return "idle";
  return row.cause === null ? "ready" : "drift";
}

function statusText(row: PortalRow): string {
  if (row.cause !== null && row.cause.disabled) return "Disabled";
  return row.enabled ? "Enabled" : "Paused";
}

/** The "Run now" control, one per row. Mirrors board.tsx's SearchNowControl (same queue, same
 *  pending/settled state machine) rather than inventing a second pattern — but every row's click
 *  enqueues the SAME whole-profile crawl (crawl-run has no per-portal params), so the button never
 *  claims to re-check only this board. A `title` carries that scope for anyone who hovers; the
 *  visible label stays the three words the mockup asks for ("Run now" / "Queuing…" / "Run
 *  queued") since a longer on-button sentence would crowd a row that already carries a switch next
 *  to it. */
function RunNowControl(props: {
  key?: string;
  profileId: string;
  onEnqueued(): void;
}): ReactNodeLike {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);

  const handleClick = useCallback(() => {
    setPending(true);
    runQueue(CRAWL_RUN_QUEUE, "crawl.run", { profileId: props.profileId })
      .then((result) => {
        setPending(false);
        setOutcome(result);
        props.onEnqueued();
      })
      .catch(() => {
        setPending(false);
        setOutcome({ kind: "error", message: "Network error" });
      });
  }, [props]);

  // "queued"/"already-queued" both read as settled-and-queued (runQueue resolves on acceptance,
  // never completion — ruling I5) — the button stays disabled rather than inviting a second click
  // that can only ever report the same thing again. "disabled" and "error" both return the button
  // to its clickable resting label; only "error" gets an inline reason, since "disabled" already
  // has its own quiet hint line below the button.
  const settled =
    outcome !== null && (outcome.kind === "queued" || outcome.kind === "already-queued");
  const label = pending ? "Queuing…" : settled ? "Run queued" : "Run now";

  return h(
    Fragment,
    null,
    <button
      type="button"
      className="jds-btn jds-btn--quiet jds-btn--sm"
      disabled={pending || settled || outcome?.kind === "disabled"}
      title="Checks every enabled board in this search."
      onClick={handleClick}
    >
      {label}
    </button>,
    outcome?.kind === "disabled" ? (
      <span className="jds-hint jsm-monitor__run-note">Manual runs are off for this account.</span>
    ) : null,
    outcome?.kind === "error" ? (
      <span className="jds-hint jds-hint--error jsm-monitor__run-note">
        Couldn&rsquo;t start: {outcome.message}
      </span>
    ) : null
  );
}

/** One watched board: the mockup's three-line row, drawn from exactly the four fields
 *  job-search.portal.list actually returns (sourceId/label/enabled/lastOkAt/cause — this file's
 *  header). What the mockup drew that isn't here: a query string (not on the wire — the only
 *  identifying text a portal has is its label), a 4-column fact grid (reduced to the one real fact,
 *  "Last success" — Schedule/Last checked/Found today don't exist anywhere in the response), and an
 *  "Edit query" button (no write path — see header). */
function MonitorRow(props: {
  key?: string;
  row: PortalRow;
  divided: boolean;
  profileId: string;
  onToggle(sourceId: string, enabled: boolean): void;
  onRunEnqueued(): void;
}): ReactNodeLike {
  const { row } = props;
  const selfDisabled = row.cause !== null && row.cause.disabled;
  const lastSuccess = formatPostedOn(row.lastOkAt);

  return (
    <KeyRow
      divided={props.divided}
      aside={
        <span className={`jds-indicator jds-indicator--${statusModifier(row)}`}>
          <span className="jds-indicator__dot" />
          <span className="jds-eyebrow">{statusText(row)}</span>
        </span>
      }
    >
      {/* Line 1: the label used everywhere else this portal is named (jds-label, not
          jds-card-title — this row opens nothing on click, so the display-weight class that
          implies interactivity would mislead). No query string alongside it: sourceId/label is
          all a portal has, there is no separate query field on the wire. */}
      <span className="jds-label">{row.label}</span>

      {/* Line 2: the one real fact. Omitted entirely (not a placeholder dash) when there's no
          successful run yet — formatPostedOn's own header is the rule this follows: an absent
          fact reads as "this board doesn't know", which is the truth. */}
      {/* Reuses the existing `.jsm-fields` wrapper (Overview's figures row, Profile's résumé
          stats) rather than a new class for what is, today, a single field — the wrapper is
          already the right shape (flex-wrap, 1.5rem gap) if a second real fact ever shows up on
          this wire. */}
      {lastSuccess !== null ? (
        <div className="jsm-fields">
          <FieldPair label="Last success">{lastSuccess}</FieldPair>
        </div>
      ) : null}

      {/* Line 3: the cause, verbatim — never a sentence this screen composes itself. */}
      {row.cause !== null ? (
        <p className={selfDisabled ? "jds-hint jds-hint--error" : "jds-hint"}>
          {row.cause.summary} {row.cause.nextAction}
        </p>
      ) : null}

      {/* Line 4: the two real actions. Run now (queues a whole-profile crawl-run — see
          RunNowControl's own header) and the enable/pause switch, kept as a switch rather than
          redrawn as the mockup's second button — this module already uses jds-switch for exactly
          this on-off pairing everywhere else (profile.tsx's briefing-detail control included), and
          a switch reads its own state at a glance the way a button's label alone doesn't. */}
      <div className="jsm-monitor__actions">
        <div role="group" aria-label={`${row.label} manual check`}>
          <RunNowControl profileId={props.profileId} onEnqueued={props.onRunEnqueued} />
        </div>
        <label className="jds-switch">
          <span className="jds-label">{row.label} monitoring</span>
          <input
            type="checkbox"
            aria-label={`Enable ${row.label} monitoring`}
            checked={row.enabled}
            onChange={(event: { target: { checked: boolean } }) =>
              props.onToggle(row.sourceId, event.target.checked)
            }
          />
          <span className="jds-switch__track">
            <span className="jds-switch__thumb" />
          </span>
        </label>
      </div>
    </KeyRow>
  );
}

// Trailing meta on the "Watched boards" section head — computed from the same rows the list
// below renders, never a separate claim. A count of zero enabled boards gets its own sentence
// instead of the arithmetic "0 enabled · all healthy", which would technically be true and
// completely misleading (nothing is healthy if nothing is running). "Needs attention" only fires
// when an enabled board actually has a cause attached — a disabled board isn't "unhealthy", it's
// off, and its own row already says so.
function watchedBoardsMeta(rows: PortalRow[]): string {
  const enabled = rows.filter((row) => row.enabled);
  if (enabled.length === 0) return "No boards enabled";
  const needsAttention = enabled.filter((row) => row.cause !== null).length;
  const enabledLabel = `${enabled.length} enabled`;
  if (needsAttention === 0) return `${enabledLabel} · all healthy`;
  if (needsAttention === enabled.length) return `${enabledLabel} · all need attention`;
  return `${enabledLabel} · ${needsAttention} need${needsAttention === 1 ? "s" : ""} attention`;
}

const TOGGLE_RECONCILE_ATTEMPTS = 5;
const TOGGLE_RECONCILE_MS = 1000;
const TOGGLE_FAILED_NOTICE = "Couldn\u2019t change that job board. Try again in a moment.";

export function SettingsScreen(props: { profile: Profile }): ReactNodeLike {
  const { profile } = props;
  const [portals, setPortals] = useState<PortalsState>({ status: "loading" });
  const [toggleNotice, setToggleNotice] = useState<string | null>(null);

  function refetchPortals(): void {
    fetchPortals(profile.profileId)
      .then((rows) => setPortals({ status: "ready", rows }))
      .catch(() => setPortals({ status: "error" }));
  }

  useEffect(() => {
    refetchPortals();
    // Deliberately omits refetchPortals from deps: it's a plain closure
    // redefined every render (not memoized) that only reads profile.profileId,
    // so keying this effect on the function reference would refetch on every
    // render instead of just when the profile changes.
  }, [profile.profileId]);

  // runQueue resolves once the job is accepted, before it runs. Reread until the stored value
  // matches the requested one, keeping the optimistic value in between.
  function reconcileToggle(sourceId: string, enabled: boolean, attempt: number): void {
    fetchPortals(profile.profileId)
      .then((rows) => {
        const stored = rows.find((row) => row.sourceId === sourceId);
        if (!stored || stored.enabled === enabled) {
          setPortals({ status: "ready", rows });
          return;
        }
        if (attempt < TOGGLE_RECONCILE_ATTEMPTS) {
          setTimeout(() => reconcileToggle(sourceId, enabled, attempt + 1), TOGGLE_RECONCILE_MS);
          return;
        }
        setPortals({ status: "ready", rows });
        setToggleNotice(TOGGLE_FAILED_NOTICE);
      })
      .catch(() => setPortals({ status: "error" }));
  }

  function handleToggle(sourceId: string, enabled: boolean): void {
    setToggleNotice(null);
    setPortals((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            rows: current.rows.map((row) => (row.sourceId === sourceId ? { ...row, enabled } : row))
          }
        : current
    );
    runQueue(PORTAL_SET_ENABLED_QUEUE, "portal.set-enabled", {
      profileId: profile.profileId,
      sourceId,
      enabled
    })
      .then((outcome) => {
        if (outcome.kind === "queued") {
          reconcileToggle(sourceId, enabled, 0);
          return;
        }
        setToggleNotice(TOGGLE_FAILED_NOTICE);
        refetchPortals();
      })
      .catch(() => {
        setToggleNotice(TOGGLE_FAILED_NOTICE);
        refetchPortals();
      });
  }

  let portalsBody: ReactNodeLike;
  let sectionMeta: string | null = null;
  if (portals.status === "loading") {
    portalsBody = <p className="jds-hint">Loading your job boards…</p>;
  } else if (portals.status === "error") {
    portalsBody = <p className="jds-hint">Couldn&rsquo;t load your job boards.</p>;
  } else if (portals.rows.length === 0) {
    portalsBody = <p className="jds-hint">No job boards yet.</p>;
  } else {
    sectionMeta = watchedBoardsMeta(portals.rows);
    portalsBody = (
      <div className="jsm-monitor__rows">
        {portals.rows.map((row, index) => (
          <MonitorRow
            key={row.sourceId}
            row={row}
            divided={index > 0}
            profileId={profile.profileId}
            onToggle={handleToggle}
            onRunEnqueued={refetchPortals}
          />
        ))}
      </div>
    );
  }

  // No card. A lone control inside a full-width sunken card left three quarters of a 1100px box
  // empty and read as a container that failed to fill, so the group sits directly on the page
  // ground at a readable measure (styles.css `.jsm-settings`) instead.
  //
  // The mockup's header carries a gold "Daily discovery · next run 7:00 AM PT" eyebrow and a
  // primary "Add a monitor" button. Neither is built: the schedule string isn't on the wire
  // anywhere a browser tool can read it (jarvis.module.json's cron is the worker's own config,
  // never exposed through a tool — inventing "7:00 AM" would be a fabricated fact, and the plainer
  // "Daily discovery" without a time reads as filler rather than information), and "Add a monitor"
  // has no queue behind it (this file's header). The explanation paragraph and the footer line
  // below carry what the header would otherwise have said.
  //
  return (
    <div className="jsm-settings">
      <h2 className="jds-section-title">Monitors</h2>

      <section className="jsm-settings__group">
        <SectionHead label="Watched boards">
          {sectionMeta !== null ? <span className="jds-eyebrow">{sectionMeta}</span> : null}
        </SectionHead>
        {portalsBody}
        {toggleNotice !== null ? (
          <p className="jds-hint" role="status">
            {toggleNotice}
          </p>
        ) : null}
      </section>

      <div className="jsm-monitor__foot">
        {/* Stands in for the mockup's "Add a monitor" / "Edit query" buttons — the one way either
            action genuinely works today (source.ts's own header: assistantTools only, no queue). */}
        <p className="jds-hint">Add or edit a job board through chat.</p>
      </div>
    </div>
  );
}

// external-modules/job-search/src/web/screens/inspector.tsx
//
// Mockup rewrite (2026-07-29, task #100): the opportunity detail screen — JobsMatches.jsx's
// DetailView, a full view-swap (board.tsx's own comment on this, task #99) in place of the old
// 26rem side panel this file used to render. Same file, same export, same prop-shape discipline —
// pure presentation, no invokeTool/runQueue, board.tsx still owns every fetch/write decision and
// hands this file the result — but the render tree below is new top to bottom: a back link,
// display-scale title, a meta line, a 3px rule, then one readable column for the description,
// independent Fit/Want evidence, scored time, and decisions. The read remains wrapped in the
// host's `.jds-governor*` block
// (components-moss.css) until a decision is made. There is no in-repo precedent for that block —
// grepped clean across every .tsx/.ts file before writing this — so its markup below is built
// directly off the CSS class semantics, not copied from an existing caller.
//
// Two structural rules this screen still exists to honor, carried over unchanged from the old side
// panel:
// - L9 (fit/want non-blending): Fit and Want stay two separately labeled values with their own
//   reasons, never summed, averaged, or folded into one "summary" paragraph — even though the
//   mockup's own DetailView wraps a single `o.summary` string in the Governor block. This board has
//   no summary field, only `fitReason`/`wantReason` (board-types.ts), and forcing them into one
//   paragraph would be exactly the "force fit/want like we have it" this rewrite was told not to do
//   — so both axes ride inside the one Governor block instead, kept apart the same way they always
//   have been.
// - Unscored visibility: a queued (not-yet-scored) match still opens here and says so plainly —
//   "queued for scoring", never "dropped" or a generic error, because it hasn't failed, it just
//   hasn't been read yet.
//
// Data the mockup's DetailView draws that this board cannot — omitted, not fabricated (the task's
// own rule): `recommendation` (no verdict field), `summary` (see L9 above),
// `evidence`/`blockers`/`gaps`/
// `prefMatch`/`prefConflict`/`unknowns` (no structured arrays exist, only the two reason strings),
// the `Profile rev … · resume rev …` provenance line (no revision concept on the wire), `workMode`/
// `comp` (BoardMatch/MatchDetail carry neither). The mockup's own fallback-copy idiom for a missing
// description ("Ask Jarvis for the full description…") is adapted, not reused verbatim, because it
// specifically claims the copy "was truncated at capture" — untrue here, since no description is
// ever captured at all.
import { Fragment, h, useEffect, useRef, type ReactNodeLike } from "../runtime";
import { Score } from "../score";
import { SectionHead, formatPostedOn } from "../keyline";
import { isScored, type BoardMatch, type MatchDetail } from "../board-types";

export interface InspectorProps {
  match: BoardMatch | null;
  // #1330: fetched by board.tsx via job-search.match.get on selection, never by this file (see
  // header). null while the fetch is in flight or hasn't started, regardless of `detailError` — the
  // two are mutually exclusive states board.tsx guarantees, not asserted again here.
  detail: MatchDetail | null;
  detailError: string | null;
  onClose(): void;
  onDismiss(matchId: string): void;
  // #100: the board's other settable state — worker/handlers/matches.ts's SETTABLE_STATES already
  // allows "seen" through the same queue path Dismiss uses, so this is real, already-wired
  // functionality, not new plumbing. Save was never reachable from the old side panel, which only
  // ever offered Dismiss; both now live together in this screen's one decision block, the same
  // single-action-surface discipline tasks-design.md already rules for a task's own action row,
  // applied here to an opportunity instead.
  onSave(matchId: string): void;
  // Task 20/#1304: null hides the control entirely rather than rendering it disabled — board.tsx is
  // null here whenever assistantSurface is absent OR detail hasn't loaded yet.
  onDiscuss: (() => void) | null;
}

// Host equivalent of the mockup's `GovernorWrapper` (a harness-only component off
// `window.JarvisParkPressDesignSystem_0501fa` — not something this repo can import). The outer
// block carries a hatched border until `is-confirmed`, `__content` sits at reduced opacity until
// then too, and `__tag` is the small icon+label line naming what's inside as unconfirmed AI output.
// The mockup's `actions={false}` on every DetailView call site means the wrapper itself never grows
// a button row — Save/Pass/Discuss live in the decision block below instead, so no
// `.jds-governor__actions` markup exists in this file at all. The tag's own copy ("read against
// your profile and résumé — nothing is sent anywhere") is the mockup's authored `reason` string,
// reused verbatim per the same discipline board.tsx's BUCKET_EMPTY already applies — authored UI
// copy, not fabricated data.
function GovernorBlock(props: { confirmed: boolean; children: ReactNodeLike }): ReactNodeLike {
  return (
    <div className={props.confirmed ? "jds-governor is-confirmed" : "jds-governor"}>
      <div className="jds-governor__tag">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
        Read against your profile and résumé — nothing is sent anywhere.
      </div>
      <div className="jds-governor__content">{props.children}</div>
    </div>
  );
}

function formatScoredAt(value: string | null): string | null {
  if (value === null) return null;
  const date = formatPostedOn(value);
  const hour = value.slice(11, 13);
  const minute = value.slice(14, 16);
  if (
    date === null ||
    !/^\d{2}$/.test(hour) ||
    !/^\d{2}$/.test(minute) ||
    Number(hour) > 23 ||
    Number(minute) > 59
  ) {
    return null;
  }
  return `${date} at ${hour}:${minute} UTC`;
}

export function Inspector(props: InspectorProps): ReactNodeLike {
  const { match, detail, detailError } = props;

  // Same scroll-into-view precaution the old side panel used, retargeted at this screen's own
  // root: opening a match near the bottom of a long list still swaps the whole view in from the
  // top, but a page already scrolled deep into that list can leave the new content starting off the
  // fold depending on where the click landed. Optional-chained throughout: the unit renderer has no
  // real DOM nodes to hand back through the ref.
  const rootRef = useRef<{ scrollIntoView?: (opts: unknown) => void } | null>(null);
  const openId = match?.id ?? null;
  useEffect(() => {
    if (openId === null) return;
    rootRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [openId]);

  if (match === null) {
    return null;
  }

  const scored = isScored(match);
  const posted = formatPostedOn(match.postedAt);
  const scoredAt = formatScoredAt(detail?.scoredAt ?? null);
  // Read off match.state, not a local optimistic flag — the same choice the old panel's
  // "Dismissed." status line already made, so reopening a Saved or Passed match from its own bucket
  // shows the real, current decision rather than whatever this component last rendered.
  const decided = match.state === "seen" || match.state === "dismissed";

  return (
    <article ref={rootRef} className="jsm-detail" aria-label={`Details for ${match.title}`}>
      <button
        type="button"
        className="jds-btn jds-btn--quiet jds-btn--sm jsm-detail__back"
        onClick={props.onClose}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to matches
      </button>

      <header className="jsm-detail__header">
        {/* The identity line: company, source, and when it was posted — plain text over
            jds-meta-sep, never bullets or slashes (match-row.tsx's own rule for the same kind of
            line). Posted is omitted entirely rather than shown as a dash when the field is empty or
            malformed, same honesty formatPostedOn already gives the board rows. */}
        <div className="jsm-detail__eyebrow">
          <span className="jds-eyebrow">{match.company}</span>
          <span className="jds-meta-sep" aria-hidden="true" />
          <span className="jds-eyebrow">{match.source}</span>
          {posted !== null
            ? h(
                Fragment,
                null,
                <span className="jds-meta-sep" aria-hidden="true" />,
                <span className="jds-eyebrow">Posted {posted}</span>
              )
            : null}
        </div>

        <h2 className="jds-display jds-display--md">{match.title}</h2>

        <div className="jsm-detail__meta">
          {!scored ? <span className="jds-eyebrow jds-eyebrow--muted">Not read yet</span> : null}
          {match.location.length > 0
            ? h(
                Fragment,
                null,
                <span className="jds-meta-sep" aria-hidden="true" />,
                <span className="jds-eyebrow">{match.location}</span>
              )
            : null}
          <span className="jds-meta-sep" aria-hidden="true" />
          {/* Real per-row data (url is BoardMatch's own field, per N39), so this works the instant
              the screen opens — it never waits on the match.get round trip the reasons below depend
              on. Inline in the meta line, not a standalone button: on a full-page detail view this
              is one fact among several, not the loudest thing on the screen the way it had to be in
              the cramped 26rem side panel. */}
          <a
            className="jds-eyebrow jsm-detail__link"
            href={match.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            View original posting
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6" />
              <path d="M10 14L21 3" />
            </svg>
          </a>
        </div>
      </header>

      <hr className="jds-divider jds-divider--ink jsm-detail__rule" />

      {/* Gold, not a badge — see match-row.tsx's own comment for the ruling; the same annotation
          must not change shape between the row and this screen. */}
      {match.outsideFrame ? (
        <span className="jds-eyebrow jds-eyebrow--gold">Outside your stated frame</span>
      ) : null}

      <div className="jsm-detail__content">
        <section className="jsm-detail__section">
          <SectionHead label="Job description" />
          {detail === null && detailError === null ? (
            <p role="status">Loading job description…</p>
          ) : detail?.body.trim() ? (
            <p className="jsm-detail__description">{detail.body}</p>
          ) : (
            <p>Job description unavailable</p>
          )}
          {detailError ? <p role="alert">{detailError}</p> : null}
        </section>

        <section className="jsm-detail__read">
          <SectionHead label="Your assistant's read" />
          <p className="jds-hint jsm-detail__axis-definition">
            Fit measures résumé evidence for the role; Want measures alignment with the work you
            said you want, independently.
          </p>
          {scored ? (
            <GovernorBlock confirmed={decided}>
              <div className="jsm-detail-axes">
                <div className="jsm-detail-axis">
                  <span className="jds-eyebrow">Fit</span>
                  {match.fit === null ? (
                    <span className="jds-hint">Not scored</span>
                  ) : (
                    <Score value={match.fit} size="lg" />
                  )}
                  {detail ? <p>{detail.fitReason}</p> : null}
                </div>
                <div className="jsm-detail-axis">
                  <span className="jds-eyebrow">Want</span>
                  <Score value={match.want} size="lg" />
                  {detail ? <p>{detail.wantReason}</p> : null}
                </div>
                {scoredAt ? <p className="jds-hint">Scored {scoredAt}</p> : null}
              </div>
            </GovernorBlock>
          ) : (
            <p role="status">
              Not read yet — this posting is queued for scoring, not dropped. Fit and Want will
              appear here once it&rsquo;s been read.
            </p>
          )}
        </section>

        <div className="jsm-detail-decision">
          <hr className="jds-divider jds-divider--ink jsm-detail__rule" />
          <span className="jds-eyebrow">Your decision</span>
          {decided ? (
            <div className="jsm-detail-decision__current">
              <span
                className={
                  match.state === "seen"
                    ? "jds-badge jds-badge--forest"
                    : "jds-badge jds-badge--neutral"
                }
              >
                {match.state === "seen" ? "Saved" : "Passed"}
              </span>
            </div>
          ) : null}
          <div className="jsm-detail-decision__actions">
            {/* Unscored rows are synthetic (no match row), so Save/Pass would change nothing. */}
            {match.state === "unscored" ? null : (
              <button
                type="button"
                className="jds-btn jds-btn--primary jds-btn--sm"
                onClick={() => props.onSave(match.id)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                Save
              </button>
            )}
            {match.state === "unscored" ? null : (
              <button
                type="button"
                className="jds-btn jds-btn--secondary jds-btn--sm"
                onClick={() => props.onDismiss(match.id)}
              >
                Pass
              </button>
            )}
            {props.onDiscuss ? (
              <button
                type="button"
                className="jds-btn jds-btn--quiet jds-btn--sm"
                onClick={props.onDiscuss}
              >
                Discuss
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

// external-modules/job-search/src/web/screens/discuss.tsx
// Task 20 (#1304): Discuss — spec §7's third action on every match, alongside Dismiss
// (screens/board.tsx, a write routed through runQueue) and Open posting (a plain external link,
// screens/inspector.tsx). Discuss is neither: it opens the profile's thread with the posting
// already present, giving the user MatchRecordCard as a LocalRow on assistantSurface.Surface
// while the model gets the same record as structured data via submitTurn's controlContext.
//
// Plan deviation, documented once here rather than left implicit: the plan's illustrative
// signatures name two domain params, `{match: Match, posting: Posting}`. The real, committed wire
// never hands the web layer that split — the only full-detail read that ever reaches the browser
// is `job-search.match.get`'s flattened `MatchDetail` (board-types.ts, #1330), which already
// joins title/company (from Posting) onto the match record. Both exports below take a single
// `MatchDetail` for the same reason board-types.ts re-declares wire shapes instead of importing
// domain Match: this file describes what actually crosses the wire, not the domain split.
import { h, useCallback, useState, type ReactNodeLike } from "../runtime";
import type { AssistantSurfaceHandleV1 } from "../../domain/seed-prompt.js";
import type { MatchDetail } from "../board-types";
import { Score } from "../score";
import { FIT_BAND_EYEBROW, FIT_BAND_LABEL, fitBand } from "../keyline";

// The card that stands in for the posting, both as the LocalRow the user sees and as the visual
// reference for what the model was just handed. Built from the record's own fields only — never
// from model prose, and never from posting.body (MatchDetail doesn't carry it at all: the body is
// what the scoring model already read, and re-sending it here would break Discuss's own byte cap
// on any real posting). Mirrors inspector.tsx's axis layout (L9: Fit and Want stay two separate
// numbers with their own reasons, never blended into one).
//
// Mockup rewrite (2026-07-29, task #101): visual pass only, no change to the contract above this
// component or to what's sent through submitTurn — brought in line with the keyline idiom the row,
// the header meta line and the detail screen's own axes already use. Fit renders as a band word
// (K-D1 superseded: never a bar, a percentage, or a pill, anywhere in this module — a raw `fit`
// number here would be the third place this rule got re-broken); Want, which K-D1 never touched,
// keeps the host's `jds-score` bar via the same `Score` component the detail screen uses, so a
// user comparing this card to the screen it was opened from sees the same two shapes.
export function MatchRecordCard(props: { detail: MatchDetail }): ReactNodeLike {
  const { detail } = props;
  const band = detail.fit !== null ? fitBand(detail.fit) : null;
  return (
    <div className="jds-card jds-card--sunken jsm-discuss-card">
      <span className="jds-eyebrow">{detail.company}</span>
      <h4 className="jds-card-title jsm-discuss-card__title">{detail.title}</h4>
      {/* Gold, not a badge, here too — the same annotation must not change shape between the
          row, the detail screen and this panel, or it reads as three different flags (match-
          row.tsx's own comment carries the ruling). */}
      {detail.outsideFrame ? (
        <span className="jds-eyebrow jds-eyebrow--gold">Outside your stated frame</span>
      ) : null}
      <div className="jsm-discuss-card__axes">
        <div className="jsm-discuss-card__axis">
          <span className="jds-eyebrow">Fit</span>
          {detail.fit === null ? (
            <p className="jsm-discuss-card__value">—</p>
          ) : (
            <span
              className={band !== null ? FIT_BAND_EYEBROW[band] : "jds-eyebrow jds-eyebrow--muted"}
            >
              {band !== null ? FIT_BAND_LABEL[band] : "—"}
            </span>
          )}
          <p>{detail.fitReason}</p>
        </div>
        <div className="jsm-discuss-card__axis">
          <span className="jds-eyebrow">Want</span>
          {/* Want is null on a still-queued match the same way Fit can be (isScored's own header,
              board-types.ts) — Discuss has no gate on scored state, so this card must handle that
              case too rather than assume detail.want is always a number. */}
          {detail.want === null ? (
            <p className="jsm-discuss-card__value">—</p>
          ) : (
            <Score value={detail.want} size="lg" />
          )}
          <p>{detail.wantReason}</p>
        </div>
      </div>
    </div>
  );
}

export interface UseDiscussResult {
  discussing: string | null;
  discuss(detail: MatchDetail): void;
  close(): void;
}

/**
 * Opens the profile's thread with `detail` already present. `assistantSurface` undefined means
 * Discuss cannot do anything real — `discuss` becomes a safe no-op (never throws, never calls
 * submitTurn) rather than the caller needing its own guard; screens/board.tsx additionally hides
 * the Discuss control entirely in that case (spec's "an action that silently does nothing is
 * worse than an action that is not there" — the no-op here is a defensive floor, not the UX).
 */
export function useDiscuss(
  assistantSurface: AssistantSurfaceHandleV1 | undefined
): UseDiscussResult {
  const [discussing, setDiscussing] = useState<string | null>(null);

  const discuss = useCallback(
    (detail: MatchDetail): void => {
      setDiscussing(detail.id);
      if (!assistantSurface) return;
      // Bind-before-send (Task 17's own rule): this hook never calls setSurfaceKey — the surface
      // is already bound to profile.id by useProfileThread before a board ever renders, and a
      // second binder here is exactly how the drawer ends up pointed at the wrong thread.
      //
      // The turn text names the posting directly rather than relying on the card to carry the
      // reference: localRows are client state (see MatchRecordCard's own header) and vanish on
      // reload while the transcript — and this text — remain.
      //
      // controlContext carries exactly the three keys core accepts (step/action/values); a field
      // parked at the top level is dropped silently, not rejected, so every posting field lives
      // inside `values`. `location` is deliberately omitted even though the plan's illustrative
      // payload names it: neither BoardMatch nor MatchDetail carries a location field on the real
      // wire (N39's own rule — a field belongs on a wire shape only if something renders or
      // consumes it — and nothing here does), so plumbing one through would invent data the
      // record never actually has. posting.body is omitted for the same byte-cap reason
      // MatchRecordCard's header gives.
      void assistantSurface.submitTurn({
        text: `About ${detail.title} at ${detail.company} — what do you think?`,
        controlContext: {
          action: "discuss",
          values: {
            title: detail.title,
            company: detail.company,
            url: detail.url,
            fit: detail.fit,
            want: detail.want,
            fitReason: detail.fitReason,
            wantReason: detail.wantReason,
            outsideFrame: detail.outsideFrame
          }
        }
      });
    },
    [assistantSurface]
  );

  const close = useCallback((): void => setDiscussing(null), []);

  return { discussing, discuss, close };
}

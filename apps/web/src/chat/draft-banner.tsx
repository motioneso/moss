/**
 * The running-draft banner (#1756) — the one raised card the draft page is allowed, per
 * `draft.html`'s mockup: what the draft reaches and keeps, the cost of shipping it, and the four
 * actions available on a draft only its author can see.
 */

export interface DraftBannerProps {
  readonly moduleId: string;
  readonly whatItReaches: string;
  readonly whatItKeeps: string;
  readonly restartRequired: string;
  readonly onShip: () => void;
  readonly onAskForChange: () => void;
  /** Absent (not just a no-op) until there's a real "see the code" surface to open. */
  readonly onSeeCode?: () => void;
  /** Absent until there's a real delete-draft action wired up. */
  readonly onThrowAway?: () => void;
  /** #1890: true while a throw-away is in flight, so the button can't be fired twice. */
  readonly throwAwayPending?: boolean;
  /** Shown as the disabled button's title when onSeeCode is absent. */
  readonly seeCodeUnavailableReason?: string;
  /** Shown as the disabled button's title when onThrowAway is absent. */
  readonly throwAwayUnavailableReason?: string;
}

export function DraftBanner(props: DraftBannerProps) {
  return (
    <div className="jds-card jds-card--raised draft-banner" data-module-id={props.moduleId}>
      <div className="jds-rail-row">
        <span className="jds-rail jds-rail--gold" />
        <div className="draft-banner__body">
          <div className="draft-banner__head">
            <h2 className="jds-card-title jds-card-title--heavy">Draft — only you can see this</h2>
            <span className="jds-indicator jds-indicator--ready jds-indicator--live">
              <span className="jds-indicator__dot" />
              Running
            </span>
          </div>
          <p className="jds-card__meta">
            Reaches {props.whatItReaches} &middot; stores {props.whatItKeeps}
          </p>
          <div className="draft-banner__actions">
            <button
              className="jds-btn jds-btn--primary jds-btn--sm"
              type="button"
              onClick={props.onShip}
            >
              Ship it
            </button>
            <button
              className="jds-btn jds-btn--secondary jds-btn--sm"
              type="button"
              onClick={props.onAskForChange}
            >
              Ask for a change
            </button>
            <span className="draft-banner__spacer" />
            <button
              className="jds-btn jds-btn--quiet jds-btn--sm"
              type="button"
              disabled={!props.onSeeCode}
              title={props.onSeeCode ? undefined : props.seeCodeUnavailableReason}
              onClick={props.onSeeCode}
            >
              See the code
            </button>
            <button
              className="jds-btn jds-btn--quiet jds-btn--sm"
              type="button"
              disabled={!props.onThrowAway || props.throwAwayPending === true}
              title={props.onThrowAway ? undefined : props.throwAwayUnavailableReason}
              onClick={props.onThrowAway}
            >
              Throw it away
            </button>
          </div>
          <p className="draft-banner__note jds-caption">{props.restartRequired}</p>
        </div>
      </div>
    </div>
  );
}

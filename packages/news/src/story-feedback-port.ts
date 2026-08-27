import type { DataContextDb } from "@moss/db";
import type { StoryRelevanceCandidate, StoryRelevanceResult } from "@moss/shared";

/**
 * The seam between News and story usefulness feedback (#2018).
 *
 * News never imports `@moss/usefulness-feedback`. Two reasons, both binding:
 * module isolation (modules collaborate only through declared public APIs), and the fact that the
 * story reference helper hashes with Node's crypto, which must never be pulled into the browser
 * bundle this package also ships. The composition root implements this port and injects it.
 */

/** Which screen a story was shown on. The feedback API keys a target on its surface. */
export type NewsStorySurface = "news" | "today";

/**
 * One story the user was actually shown, described only as far as Settings needs to recognise it
 * later. No article URL, no excerpt, no body: the metadata allow-list on the far side drops
 * anything wider, silently, so keeping this narrow is not optional politeness.
 */
export interface NewsStoryTargetRow {
  readonly storyRef: string;
  readonly surface: NewsStorySurface;
  readonly headline: string;
  readonly sourceLabel: string;
  readonly publishedAt: string | null;
  readonly topicRef: string | null;
  /** Whether this story led its publisher's own list — editorial evidence, not our judgement. */
  readonly hasEditorialEvidence: boolean;
}

export interface NewsStoryFeedbackPort {
  /** The opaque, stable reference for a story. Derived from its canonical link. */
  storyRef(canonicalUrl: string): string;
  /**
   * Record the stories currently on screen as targets the feedback API will accept. Nothing else
   * writes these rows, and the API refuses a story it has no row for, so an unregistered story can
   * never receive a preference.
   */
  registerTargets(
    scopedDb: DataContextDb,
    ownerUserId: string,
    rows: readonly NewsStoryTargetRow[]
  ): Promise<void>;
  /** The shared relevance policy, bound to the News module and the owner's configured model. */
  applyRelevance(
    scopedDb: DataContextDb,
    input: {
      readonly ownerUserId: string;
      readonly candidates: readonly StoryRelevanceCandidate[];
      readonly now: Date;
    }
  ): Promise<StoryRelevanceResult>;
}

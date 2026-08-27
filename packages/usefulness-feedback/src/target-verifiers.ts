import type { FeedbackSurface, FeedbackTargetKind, UsefulnessFeedbackKind } from "@moss/shared";

import type { DataContextDb } from "@moss/db";

export interface FeedbackTargetVerification {
  readonly ownerUserId: string;
  readonly targetKind: FeedbackTargetKind;
  readonly targetRef: string;
  readonly surface: FeedbackSurface;
  readonly sourceKind?: string;
  readonly sourceLabel?: string;
  readonly priorityBand?: "critical" | "high" | "normal" | "low";
  readonly metadata?: Record<string, unknown>;
  readonly canRemember: boolean;
  readonly rememberExcerpt?: string;
}

export type FeedbackTargetVerifier = (
  scopedDb: DataContextDb,
  input: {
    readonly actorUserId: string;
    readonly targetKind: FeedbackTargetKind;
    readonly targetRef: string;
    readonly surface: FeedbackSurface;
  }
) => Promise<FeedbackTargetVerification | null>;

export class FeedbackTargetVerifierRegistry {
  readonly #verifiers = new Map<FeedbackTargetKind, FeedbackTargetVerifier>();

  register(targetKind: FeedbackTargetKind, verifier: FeedbackTargetVerifier): void {
    this.#verifiers.set(targetKind, verifier);
  }

  get(targetKind: FeedbackTargetKind): FeedbackTargetVerifier | undefined {
    return this.#verifiers.get(targetKind);
  }
}

const KINDS_BY_TARGET: Readonly<Record<FeedbackTargetKind, ReadonlySet<UsefulnessFeedbackKind>>> = {
  chat_message: new Set(["more_like_this", "not_useful", "remember_this"]),
  briefing_run: new Set(["more_like_this", "too_much", "not_useful", "dismiss"]),
  briefing_item: new Set([
    "more_like_this",
    "too_much",
    "wrong_priority",
    "not_useful",
    "dismiss",
    "remember_this"
  ]),
  proactive_card: new Set([
    "more_like_this",
    "too_much",
    "wrong_priority",
    "not_useful",
    "dismiss",
    "remember_this"
  ]),
  // Story feedback is an ongoing preference, so it takes only the two directions. `not_useful`
  // stays off the list on purpose: it describes one item that was shown, not a standing rule.
  news_story: new Set(["more_like_this", "less_like_this"]),
  sports_story: new Set(["more_like_this", "less_like_this"])
};

const SURFACES_BY_TARGET: Readonly<Record<FeedbackTargetKind, ReadonlySet<FeedbackSurface>>> = {
  chat_message: new Set(["chat"]),
  briefing_run: new Set(["briefing"]),
  briefing_item: new Set(["briefing", "today"]),
  proactive_card: new Set(["proactive", "today"]),
  news_story: new Set(["news", "today"]),
  sports_story: new Set(["sports", "today"])
};

export function isAllowedFeedbackPair(
  targetKind: FeedbackTargetKind,
  surface: FeedbackSurface,
  kind: UsefulnessFeedbackKind
): boolean {
  return KINDS_BY_TARGET[targetKind].has(kind) && SURFACES_BY_TARGET[targetKind].has(surface);
}

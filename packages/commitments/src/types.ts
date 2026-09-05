import type { ProposedCommitmentAction } from "@moss/module-sdk";

export type CommitmentCandidateKind = "deadline" | "promise" | "obligation" | "intent";
export type CommitmentCandidateStatus =
  | "pending_review"
  | "accepted"
  | "rejected"
  | "snoozed"
  | "expired"
  | "explicit_non_action";
export type CommitmentSuggestedHandling =
  | "create_task"
  | "create_goal"
  | "create_calendar_event"
  | "send_reply"
  | "dismiss";
export type CommitmentSourceKind = "chat" | "email" | "notes";

export interface CommitmentCandidate {
  readonly id: string;
  readonly ownerUserId: string;
  readonly candidateSignature: string;
  readonly kind: CommitmentCandidateKind;
  readonly title: string;
  readonly dueLocalDate: string | null;
  readonly counterpartyLabel: string | null;
  readonly status: CommitmentCandidateStatus;
  readonly confidence: "high" | "medium" | "low";
  readonly suggestedHandling: CommitmentSuggestedHandling | null;
  readonly resolutionRef: string | null;
  readonly suppressedBy: string | null;
  readonly sourceCount: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly snoozedUntil: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  // Email-thread candidates only (spec 2026-09-04-email-chief-of-staff); absent elsewhere.
  readonly counterpartyPersonId?: string | null;
  readonly counterpartyAddress?: string | null;
  readonly proposedActions?: readonly ProposedCommitmentAction[];
  readonly whyLines?: readonly string[];
  readonly threadRef?: string | null;
  readonly lastJudgedExternalId?: string | null;
  readonly stale?: boolean;
}

export interface CommitmentCandidateSource {
  readonly id: string;
  readonly candidateId: string;
  readonly ownerUserId: string;
  readonly sourceKind: CommitmentSourceKind;
  readonly sourceRef: string;
  readonly sourceVersion: number;
  readonly evidenceExcerpt: string;
  readonly occurredAt: Date | null;
  readonly createdAt: Date;
}

export interface CommitmentExtractionState {
  readonly id: string;
  readonly ownerUserId: string;
  readonly sourceKind: CommitmentSourceKind;
  readonly lastExtractedAt: Date | null;
  readonly lastRunAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertCandidateInput {
  readonly ownerUserId: string;
  readonly candidateSignature: string;
  readonly kind: CommitmentCandidateKind;
  readonly title: string;
  readonly dueLocalDate: string | null;
  readonly counterpartyLabel: string | null;
  readonly confidence: "high" | "medium" | "low";
  readonly suggestedHandling: CommitmentSuggestedHandling | null;
  readonly occurredAt: string | null;
}

/** One judged email thread becoming (or refreshing) a candidate. */
export interface UpsertEmailCandidateInput extends Omit<UpsertCandidateInput, "occurredAt"> {
  readonly counterpartyPersonId: string | null;
  readonly counterpartyAddress: string | null;
  readonly proposedActions: readonly ProposedCommitmentAction[];
  readonly whyLines: readonly string[];
  readonly threadRef: string;
  readonly lastJudgedExternalId: string;
}

export type EmailThreadJudgementOutcomeKind = "no_item" | "item";

export interface AddEvidenceInput {
  readonly candidateId: string;
  readonly ownerUserId: string;
  readonly sourceKind: CommitmentSourceKind;
  readonly sourceRef: string;
  readonly sourceVersion: number;
  readonly evidenceExcerpt: string;
  readonly occurredAt: string | null;
}

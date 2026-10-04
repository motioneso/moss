/**
 * Commitment extraction and email-thread judgement contracts.
 *
 * Provider interfaces a module implements so core can find, verify and act on commitments in
 * source text. Types only, so the barrel stays browser-safe.
 */

/** Boundary of text from a source that may contain commitments. */
export interface CommitmentTextBoundary {
  readonly sourceRef: string;
  readonly sourceVersion: number;
  readonly text: string;
  readonly occurredAt: string;
}

/** A single extracted commitment candidate returned by the AI extractor. */
export interface ExtractedCommitmentCandidate {
  readonly kind: "deadline" | "promise" | "obligation" | "intent";
  readonly title: string;
  readonly dueLocalDate: string | null;
  readonly counterpartyLabel: string | null;
  readonly evidenceExcerpt: string;
  readonly confidence: "high" | "medium" | "low";
}

/**
 * Implemented by source modules (chat, email, notes) to supply text boundaries
 * for commitment extraction. The Commitments module never imports source module
 * internals — it invokes only this interface.
 */
export interface CommitmentExtractionProvider {
  readonly sourceKind: "chat" | "email" | "notes";
  getTextBoundaries(
    scopedDb: unknown,
    actorUserId: string,
    since: Date | null
  ): Promise<CommitmentTextBoundary[]>;
}

/**
 * Validates that a resolution reference is real and owned by the actor before
 * it is stored on a candidate. Missing verifier → 503 (not 500).
 */
export interface CommitmentResolutionVerifier {
  verifyResolutionRef(
    scopedDb: unknown,
    actorUserId: string,
    resolutionRef: string
  ): Promise<{ readonly valid: boolean; readonly reason?: string }>;
}

/**
 * Email as chief of staff (spec docs/superpowers/specs/2026-09-04-email-chief-of-staff-design.md).
 * The email module asks the Commitments module to judge one thread; Commitments reads the thread
 * back through EmailThreadProvider and enriches the judgement through the optional context
 * providers. Everything crosses the module boundary through these types only.
 */
export interface EmailThreadJudgementRequester {
  requestThreadJudgement(actorUserId: string, threadRef: string): Promise<void>;
}

export interface EmailThreadMessage {
  readonly externalId: string;
  /** app.email_messages.id, what email.draftReply / sendReply take. */
  readonly cacheMessageId: string;
  readonly fromAddress: string;
  readonly fromIsUser: boolean;
  readonly subject: string;
  readonly receivedAt: string;
  /** Capped by the provider to 4_000 chars. */
  readonly bodyExcerpt: string;
}

export interface EmailThreadProvider {
  listThreadMessages(
    scopedDb: unknown,
    actorUserId: string,
    threadRef: string
  ): Promise<readonly EmailThreadMessage[]>;
  /**
   * Threads with an open email candidate that received a message newer than the given message id.
   * Slice 2 uses it.
   */
  listThreadsWithNewerMessages(
    scopedDb: unknown,
    actorUserId: string,
    threads: readonly { threadRef: string; afterExternalId: string }[]
  ): Promise<readonly { threadRef: string; newest: EmailThreadMessage }[]>;
}

export interface CommitmentPersonContext {
  readonly personId: string | null;
  readonly displayName: string | null;
  readonly relationshipSummary: string | null;
  readonly recentNoteLines: readonly string[];
}
export interface CommitmentOpenTask {
  readonly id: string;
  readonly title: string;
  readonly dueLocalDate: string | null;
}
export interface CommitmentCalendarWindow {
  readonly busy: readonly { start: string; end: string; title: string }[];
  readonly timezone: string;
}

export interface CommitmentContextProviders {
  people?: {
    resolveByEmail(
      scopedDb: unknown,
      actorUserId: string,
      address: string
    ): Promise<CommitmentPersonContext | null>;
  };
  notes?: {
    searchLines(
      scopedDb: unknown,
      actorUserId: string,
      query: string,
      limit: number
    ): Promise<readonly string[]>;
  };
  tasks?: {
    listOpen(
      scopedDb: unknown,
      actorUserId: string,
      limit: number
    ): Promise<readonly CommitmentOpenTask[]>;
  };
  calendar?: {
    windowFromNow(
      scopedDb: unknown,
      actorUserId: string,
      days: number
    ): Promise<CommitmentCalendarWindow | null>;
  };
}

export type ProposedCommitmentAction =
  | { kind: "reply"; facts: readonly string[]; wantsFreeSlots: boolean }
  | { kind: "task"; title: string; dueLocalDate: string | null }
  | { kind: "snooze"; untilLocalDate: string }
  | { kind: "dismiss" };

export interface EmailJudgementOutcome {
  readonly owed: boolean;
  readonly title: string | null;
  readonly counterpartyLabel: string | null;
  readonly counterpartyAddress: string | null;
  readonly dueLocalDate: string | null;
  readonly confidence: "high" | "medium" | "low";
  /** Max 3, each max 240 chars. */
  readonly why: readonly string[];
  /** Max 4. */
  readonly actions: readonly ProposedCommitmentAction[];
}
